import { useCallback, useEffect, useState } from 'react';
import type { InterStemContact, InterStemStatus } from '../../shared/types';

/**
 * Inter-Stem status (addresses, contacts, connection), refreshed on every
 * `interstem:changed`. Null until loaded, or on a server without inter-Stem
 * mail (an older server answers the channel with an error).
 */
export function useInterStem(): { status: InterStemStatus | null; refresh: () => void; contact: (address: string) => InterStemContact | undefined } {
  const [status, setStatus] = useState<InterStemStatus | null>(null);
  const refresh = useCallback(() => {
    window.stem
      .interStemStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  useEffect(() => {
    refresh();
    return window.stem.onInterStemChanged(refresh);
  }, [refresh]);
  const contact = useCallback((address: string) => status?.contacts.find((c) => c.address === address), [status]);
  return { status, refresh, contact };
}

/** A fingerprint grouped in fours, for reading aloud or comparing side by side. */
export function formatFingerprint(fp: string): string {
  return (fp.slice(0, 32).match(/.{1,4}/g) ?? []).join(' ');
}
