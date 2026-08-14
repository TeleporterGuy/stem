// The root of the app: the transport, mounted once, above every route.
//
// expo-router rather than a hand-rolled navigator because of what comes next —
// step 5 adds a thread view, and step 6 makes a push notification open one. A
// deep link that has to reach a screen is exactly the problem file-based routing
// already solves, and doing it by hand later would mean unpicking a navigator.

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import type { ReactElement } from 'react';
import { TransportProvider } from '../src/transport/provider';

export default function RootLayout(): ReactElement {
  return (
    <TransportProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }} />
    </TransportProvider>
  );
}
