// The root of the app: the transport, mounted once, above every route.
//
// expo-router rather than a hand-rolled navigator because of what comes next —
// step 5 adds a thread view, and step 6 makes a push notification open one. A
// deep link that has to reach a screen is exactly the problem file-based routing
// already solves, and doing it by hand later would mean unpicking a navigator.
//
// The approval sheet is mounted HERE, above the router, and that placement is
// the design: an approval holds a backend tool call open until a client answers,
// so it cannot belong to a screen the user might navigate away from. Whatever is
// on screen, the question is on top of it.

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import type { ReactElement } from 'react';
import { TransportProvider } from '../src/transport/provider';
import { ApprovalSheet } from '../src/ui/ApprovalSheet';

export default function RootLayout(): ReactElement {
  return (
    <TransportProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }} />
      <ApprovalSheet />
    </TransportProvider>
  );
}
