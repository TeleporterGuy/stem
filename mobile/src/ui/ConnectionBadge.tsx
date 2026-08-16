// The connection dot, in the header of every screen that shows server data.
//
// It exists because everything else in this app is a lie when the stream is
// down: a chat list from four hours ago looks exactly like a chat list from four
// seconds ago. The dot is the only thing on screen that can tell them apart.

import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTransport } from '../transport/provider';
import { describeConnection, type ConnectionTone } from './connection';
import { useTheme, type Theme } from './theme';

function toneColor(theme: Theme, tone: ConnectionTone): string {
  if (tone === 'live') return theme.live;
  if (tone === 'warn') return theme.warn;
  if (tone === 'bad') return theme.bad;
  return theme.dim;
}

export function ConnectionBadge(): ReactElement {
  const { status } = useTransport();
  const theme = useTheme();
  const { label, tone } = describeConnection(status);
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: toneColor(theme, tone) }]} />
      <Text style={[styles.label, { color: theme.dim }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { fontSize: 13 }
});
