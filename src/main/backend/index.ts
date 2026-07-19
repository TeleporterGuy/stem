import { piHome, piSessionsDir, workspaceRoot } from '../workspace/paths';
import { PiRuntime } from '../pi/runtime';
import { FakeBackend } from './fake';
import type { ChatBackend } from './types';

export type { ChatBackend } from './types';

/**
 * Construct the active backend. pi is the only real backend; it's kept behind
 * the {@link ChatBackend} seam so the rest of the app stays backend-agnostic.
 *
 * Under STEM_E2E the seam gets the hermetic {@link FakeBackend} instead: the
 * whole app (IPC, event routing, renderers, Recall, scheduler) runs for real
 * against deterministic scripted turns, with no pi process, auth, or network.
 * STEM_E2E_ONBOARDING additionally starts it unauthenticated so specs can
 * drive the first-run wizard.
 */
export function createBackend(options?: { seedGlobalAuth?: boolean }): ChatBackend {
  if (process.env.STEM_E2E) {
    return new FakeBackend({
      piHome: piHome(),
      workspaceRoot: workspaceRoot(),
      startAuthenticated: !process.env.STEM_E2E_ONBOARDING
    });
  }
  return new PiRuntime({
    piHome: piHome(),
    sessionsDir: piSessionsDir(),
    workspaceRoot: workspaceRoot(),
    seedGlobalAuth: options?.seedGlobalAuth
  });
}
