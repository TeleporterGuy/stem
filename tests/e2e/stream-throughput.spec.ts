// What the SSE hop costs per streamed delta.
//
// The Phase 1 plan calls this out as a blocker rather than a footnote: before the
// split, a token delta went from the backend to the window as a direct function
// call in one process. Now it is JSON-serialized, written to a loopback socket,
// read back, parsed, and only then fanned out to the window — and that is now
// sitting in front of a token render loop that has never had anything in front of
// it. The phone bridge always paid this cost; the desk never did.
//
// So measure it, hermetically, on the delivery path rather than on React: the
// probe below counts `item/agentMessage/delta` events arriving at the RENDERER,
// through the whole chain (server emit → SSE frame → main-process parse → proxy
// fan-out → webContents.send → preload → listener). The FakeBackend's `[e2e:burst]`
// script emits BURST_DELTAS of them with no pacing at all, so what is left in the
// clock is the transport and nothing else.
//
// The budget is deliberately loose — this is here to catch a regression of the
// kind "somebody made the fan-out O(n) in connected clients", not to police
// microseconds. What the run actually measured is printed either way, because the
// number is the point, and it is printed for BOTH configurations: embedded, and
// with the server in its own process. If those two ever diverge sharply, the
// interesting thing is the divergence.
//
// Read the number as THROUGHPUT, not as per-event latency. The burst is emitted
// in a single tick, so the frames go out in one batch and are parsed in one pass;
// a real model paces its tokens tens of milliseconds apart, and each of those is
// its own write and its own event-loop wakeup, which this cannot see. That is the
// right thing to measure here anyway — a per-delta cost that is invisible at 400
// in a row is invisible at one every 20ms — but it is not the whole picture, and
// the wall-clock backstop for the paced case is tests/e2e/perf.spec.ts.
import { closeApp, expect, launchApp, mainWindowOf, test } from './electron';
import type { Page } from '@playwright/test';

/** Matches BURST_DELTAS in src/server/backend/fake.ts. */
const EXPECTED_DELTAS = 400;

/**
 * Per-delta ceiling for the whole delivery chain. ~25x the cost measured on the
 * author's machine, because CI runners are slower and shared, and because a
 * budget that fails on a bad afternoon teaches people to ignore it. A real
 * regression here is an order of magnitude, not a percentage.
 */
const BUDGET_MS_PER_DELTA = 2;

interface Probe {
  count: number;
  firstMs: number;
  lastMs: number;
}

/** Install a delta counter on `window.stem` before the turn that feeds it. */
async function installProbe(win: Page): Promise<void> {
  await win.evaluate(() => {
    const w = window as any;
    w.__streamProbe = { count: 0, firstMs: 0, lastMs: 0 };
    w.stem.onBackendEvent((event: { method: string }) => {
      if (event.method !== 'item/agentMessage/delta') return;
      const probe = w.__streamProbe;
      probe.lastMs = performance.now();
      if (probe.count === 0) probe.firstMs = probe.lastMs;
      probe.count += 1;
    });
  });
}

async function measure(win: Page, label: string): Promise<void> {
  await installProbe(win);

  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill('[e2e:burst] measure the wire');
  await composer.press('Enter');

  // Wait on the turn settling, not on a delta count: a partial burst that stalls
  // must fail as "the deltas never arrived", not as an impressively fast number.
  await expect(win.getByTitle('Stop')).toHaveCount(0, { timeout: 30_000 });

  const probe = (await win.evaluate(() => (window as any).__streamProbe)) as Probe;
  expect(probe.count, 'every delta the server emitted reached the renderer').toBe(EXPECTED_DELTAS);

  // first → last, so the RPC round trip and the backend's own start-up steps are
  // outside the window. What is inside is delivery, and only delivery.
  const elapsed = probe.lastMs - probe.firstMs;
  const perDelta = elapsed / (probe.count - 1);
  console.log(
    `[stream] ${label}: ${probe.count} deltas in ${elapsed.toFixed(1)}ms — ` +
      `${perDelta.toFixed(3)}ms each, ${Math.round(1000 / perDelta)} deltas/s`
  );
  expect(
    perDelta,
    `${label}: ${perDelta.toFixed(3)}ms per delta over budget ${BUDGET_MS_PER_DELTA}ms — the transport got ` +
      'an order of magnitude slower, or the fan-out grew work per connected client'
  ).toBeLessThan(BUDGET_MS_PER_DELTA);
}

test('deltas reach the renderer fast enough — embedded server', async ({ mainWindow }) => {
  await measure(mainWindow, 'embedded');
});

test('deltas reach the renderer fast enough — external stem-server', async () => {
  const launched = await launchApp({ externalServer: true });
  try {
    const win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');
    // The same wire, with a process boundary in the middle of it. Both listeners
    // are loopback sockets, so this should land within noise of the embedded
    // number; a large gap would mean the embedded case is quietly cheating.
    await measure(win, 'external');
  } finally {
    await closeApp(launched);
  }
});
