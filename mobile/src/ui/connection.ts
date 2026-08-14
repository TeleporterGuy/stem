// What the connection dot says, decided in one place.
//
// The four booleans in ConnectionStatus can hold sixteen combinations and only
// five of them mean anything to a person, so the mapping is a function with a
// test rather than a chain of ternaries in a component. The ORDER is the whole
// content of it:
//
//   not paired      before anything else — with no credential the other three
//                   fields are about nobody.
//   pairing dead    a 401 outranks "offline", because waiting will not fix it
//                   and the user is the only one who can.
//   live            a stream is open: events would arrive if anything happened.
//                   This is the only state in which the phone is actually current.
//   connecting      the server answers RPCs but no stream is open yet — the
//                   ordinary state for the first second after launch.
//   offline         nothing answered.

import type { ConnectionStatus } from '../transport/connection';

export type ConnectionTone = 'live' | 'warn' | 'bad' | 'dim';

export interface ConnectionDescription {
  label: string;
  tone: ConnectionTone;
}

export function describeConnection(status: ConnectionStatus): ConnectionDescription {
  if (!status.paired) return { label: 'Not paired', tone: 'dim' };
  if (status.unauthorized) return { label: 'Pairing rejected', tone: 'bad' };
  if (status.streaming) return { label: 'Live', tone: 'live' };
  if (status.reachable) return { label: 'Connecting', tone: 'warn' };
  return { label: 'Offline', tone: 'bad' };
}
