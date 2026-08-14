// The chat list — the whole of the app's UI at step 4, and deliberately so.
//
// It is here to prove the transport end to end rather than to be a chat client:
// a list that arrives over POST /rpc, re-fetches itself when the event stream
// says something changed, shows which threads are working from the snapshot
// frame, and tells the truth about the connection while it does. Step 5 hangs
// the thread view off a row; nothing here needs to change for it.

import { Redirect, Stack } from 'expo-router';
import { useMemo, type ReactElement } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { ChatSummary } from '@shared/types';
import { useChatList } from '../src/hooks/useChatList';
import { useLiveTurns } from '../src/hooks/useLiveTurns';
import { useTransport } from '../src/transport/provider';
import { ConnectionBadge } from '../src/ui/ConnectionBadge';
import { useTheme, type Theme } from '../src/ui/theme';
import { relativeTime } from '../src/ui/time';

export default function ChatsScreen(): ReactElement {
  const { pairing, unpair } = useTransport();
  const theme = useTheme();
  const { list, loading, error, refresh } = useChatList();
  const live = useLiveTurns();

  const chats = useMemo(
    () => (list ? [...list.chats].sort((a, b) => b.updatedAt - a.updatedAt) : []),
    [list]
  );

  const askToUnpair = (): void => {
    Alert.alert(
      'Unpair this phone?',
      'The token is deleted from this device. The server keeps its record until you revoke it there.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unpair', style: 'destructive', onPress: () => void unpair() }
      ]
    );
  };

  // Undefined means the Keychain has not answered yet — which is not the same as
  // "not paired", and showing the pairing screen for that instant would flash it
  // at every launch.
  if (pairing === undefined) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <ActivityIndicator color={theme.dim} />
      </View>
    );
  }
  if (pairing === null) return <Redirect href="/pair" />;

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <Stack.Screen options={{ title: 'Chats', headerRight: () => <ConnectionBadge /> }} />
      {error ? (
        <View style={[styles.banner, { backgroundColor: theme.card, borderColor: theme.line }]}>
          <Text style={[styles.bannerText, { color: theme.bad }]}>{error}</Text>
        </View>
      ) : null}
      <FlatList
        data={chats}
        keyExtractor={(chat) => chat.threadId}
        refreshControl={<RefreshControl refreshing={loading && list !== null} onRefresh={refresh} tintColor={theme.dim} />}
        ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: theme.line }]} />}
        ListEmptyComponent={
          loading ? null : (
            <Text style={[styles.empty, { color: theme.dim }]}>
              No chats on this server yet. Start one at the desk and it will appear here.
            </Text>
          )
        }
        ListFooterComponent={
          <View style={styles.footer}>
            <Text style={[styles.footerUrl, { color: theme.dim }]}>{pairing.serverUrl}</Text>
            <Pressable onPress={askToUnpair} hitSlop={8}>
              <Text style={[styles.footerAction, { color: theme.bad }]}>Unpair this phone</Text>
            </Pressable>
          </View>
        }
        renderItem={({ item }) => <ChatRow chat={item} theme={theme} working={live.has(item.threadId)} />}
      />
    </View>
  );
}

function ChatRow({ chat, theme, working }: { chat: ChatSummary; theme: Theme; working: boolean }): ReactElement {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
          {chat.subject ?? chat.title}
        </Text>
        {chat.preview ? (
          <Text numberOfLines={1} style={[styles.preview, { color: theme.dim }]}>
            {chat.preview}
          </Text>
        ) : null}
      </View>
      {working ? <View style={[styles.working, { backgroundColor: theme.live }]} /> : null}
      <Text style={[styles.time, { color: theme.dim }]}>{relativeTime(chat.updatedAt)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  banner: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  bannerText: { fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14 },
  rowText: { flex: 1, gap: 3 },
  title: { fontSize: 16, fontWeight: '600' },
  preview: { fontSize: 13 },
  working: { width: 7, height: 7, borderRadius: 4 },
  time: { fontSize: 12, minWidth: 34, textAlign: 'right' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  empty: { fontSize: 14, textAlign: 'center', paddingHorizontal: 32, paddingVertical: 48, lineHeight: 20 },
  footer: { alignItems: 'center', gap: 8, paddingVertical: 28 },
  footerUrl: { fontSize: 12 },
  footerAction: { fontSize: 14 }
});
