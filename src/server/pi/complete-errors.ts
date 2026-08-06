import { stderrReason } from './rpc';

/** Error when a throwaway complete() child ends with no assistant text. */
export function emptyCompleteError(stderr: string): Error {
  const reason = stderrReason(stderr);
  return new Error(
    reason ? `pi completion returned no text: ${reason}` : 'pi completion returned no text.'
  );
}
