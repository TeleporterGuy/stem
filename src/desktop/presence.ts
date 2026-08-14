import { log } from '../server/log';

// Telling the server somebody is actually at this machine, so it doesn't wake a
// phone for something the person is already looking at.
//
// The one thing being reported is real input. Electron's powerMonitor gives the
// OS idle timer — seconds since the last key or pointer event anywhere on the
// desktop — and while that is small, a human is here. A client that merely has
// the app running, or an event stream open, reports nothing: a laptop left open
// on a desk holds both of those for days, and treating them as presence would
// silence the phone in exactly the case the phone exists for.
//
// The protocol is "the client decides". The server does not read the idle number
// it is sent (see src/server/ipc/devices.ts); it takes a report ARRIVING as the
// claim, and stops believing it after its own window. So the gate below is the
// whole of this client's half of the contract: once the machine is idle past the
// limit the heartbeat must fall silent, because nothing downstream will do it.
//
// A failed beat is dropped. There is no retry, no queue and no backoff — the
// next tick is a fresh, better-informed report a minute later, and a beat that
// failed described a minute that has already passed. The first failure is logged
// once per launch so a wrong pairing or a firewall is findable; after that this
// stays quiet, because the common failure is a closed laptop's network and it
// would otherwise write a line a minute all night.

/**
 * How idle the machine may be and still count as occupied.
 *
 * This is a SEPARATE constant from the server's PRESENCE_WINDOW_MS
 * (src/server/push/presence.ts), which happens to be the same five minutes, and
 * that is deliberate on both sides. They answer different questions — "should I
 * still be reporting" here, "was that report recent enough to trust" there — and
 * a server this desktop has never met is free to have picked another number.
 * They only have to be in the same ballpark for the pair to behave sanely, not
 * equal, so neither imports the other's.
 */
export const PRESENCE_IDLE_LIMIT_SECONDS = 5 * 60;

/**
 * How often to look. Well inside either window, so a person who steps away for a
 * minute and comes back never falls out of it, and cheap enough to be invisible:
 * one idle-timer read and one small POST.
 */
export const HEARTBEAT_EVERY_MS = 60_000;

/**
 * Report, or stay quiet? The whole decision, kept pure so the rule can be tested
 * without an Electron runtime or a clock.
 *
 * A number that isn't one — powerMonitor is a native call, and a platform that
 * cannot answer is likelier than it sounds — reads as "no idea", and no idea is
 * not evidence anybody is here. Fail-quiet, which costs a redundant notification
 * rather than a missed one.
 *
 * `timerHasMoved` is the same fail-quiet rule applied to a backend that answers
 * WITHOUT working. Under XWayland (and any other setup where the X idle
 * extension is missing) getSystemIdleTime does not throw — it returns a constant
 * zero — and a constant zero is indistinguishable, one reading at a time, from
 * somebody with their hand on the mouse. Believed, it reports presence forever
 * and silences every push this feature exists to send, which inverts the failure
 * mode above from "one notification too many" into "none, ever, and no way to
 * tell". So a zero only counts once this process has seen the timer at some
 * NONZERO value: a working timer shows one within a beat or two, because nobody
 * touches input in every single second for hours, and a broken one never does.
 * The cost of the wait is at most a redundant notification, which is the side
 * this is meant to fail on.
 */
export function shouldReportPresence(idleSeconds: number, timerHasMoved: boolean): boolean {
  if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return false;
  if (idleSeconds >= PRESENCE_IDLE_LIMIT_SECONDS) return false;
  // A nonzero reading proves the timer for itself, so an idle machine that comes
  // back into use reports on the very beat it does.
  return idleSeconds > 0 || timerHasMoved;
}

export interface PresenceDeps {
  /** Seconds since the last input anywhere on this machine (powerMonitor). */
  idleSeconds(): number;
  /** Send one report to the server — `devices:presence` through the proxy. */
  report(idleSeconds: number): Promise<unknown>;
}

export interface PresenceHeartbeat {
  /** Begin reporting (beats once now, then every HEARTBEAT_EVERY_MS). */
  start(): void;
  /** Stop (quit; tests). */
  close(): void;
}

/**
 * The heartbeat. Injected rather than reaching for `powerMonitor` and the proxy
 * itself, for the reason the updater and the OAuth courier are: it makes the one
 * interesting thing here — when it speaks and when it doesn't — testable without
 * an Electron runtime or a server.
 */
export function createPresenceHeartbeat(deps: PresenceDeps): PresenceHeartbeat {
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  /** One report at a time: a beat stuck behind a timeout must not stack up. */
  let inFlight = false;
  /** See the header — the first failure is a diagnostic, the rest are noise. */
  let loggedFailure = false;
  /**
   * Has the OS idle timer ever been seen at a value other than zero? Until it
   * has, this process has no evidence the timer is a timer at all — see
   * shouldReportPresence. Once, and for the life of the process: a backend that
   * counted seconds a minute ago is not going to stop being one.
   */
  let timerHasMoved = false;

  async function beat(): Promise<void> {
    if (closed || inFlight) return;
    let idle: number;
    try {
      idle = deps.idleSeconds();
    } catch {
      // A platform that cannot answer answers every time; nothing to say about it.
      return;
    }
    if (Number.isFinite(idle) && idle > 0) timerHasMoved = true;
    if (!shouldReportPresence(idle, timerHasMoved)) return;
    inFlight = true;
    try {
      await deps.report(idle);
    } catch (e) {
      if (!loggedFailure) {
        loggedFailure = true;
        log('push', 'presence heartbeat failed (silent from here on)', {
          error: String((e as Error)?.message ?? e)
        });
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer || closed) return;
      timer = setInterval(() => void beat(), HEARTBEAT_EVERY_MS);
      // Launching Stem is itself input. Waiting out the first interval would
      // leave a minute in which a push could be sent to the phone of somebody
      // demonstrably sitting at their desk.
      void beat();
    },
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
