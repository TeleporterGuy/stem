// The one import of `expo/fetch` in the app.
//
// React Native's built-in fetch is implemented on XMLHttpRequest, which has no
// way to hand back a body before it is complete — an SSE stream would be read in
// full or not at all, which is to say never. `expo/fetch` is a WinterCG fetch
// over the native networking stack with a real ReadableStream body, and it is
// what makes a hand-rolled SSE reader possible on a phone at all.
//
// Isolated here so ./stream.ts stays a plain module that a Node test can import:
// the reader takes its fetch as a dependency, and this is the one line of the
// app that knows which one it really is.

import { fetch as expoFetch } from 'expo/fetch';
import type { StreamingFetch } from './stream';

export const streamingFetch: StreamingFetch = (url, init) => expoFetch(url, init);
