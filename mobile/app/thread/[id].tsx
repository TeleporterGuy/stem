// One conversation, on a phone.
//
// The state is entirely useThread's; this file is the rendering and the two
// interactions the desktop's chat view also has and for the same reasons:
//
//   FOLLOW-THE-STREAM. Pinned to the bottom while a reply arrives, released the
//   moment the user scrolls up to read something, re-pinned when they come back
//   down. The rule is ../../src/ui/scroll.ts; the wiring is that content growing
//   (a token) and the viewport moving (a finger) are two different events and
//   only the second one may change the decision.
//
//   ACTIVITY. What the model is doing between "sent" and the first token is the
//   difference between a live app and a frozen one, so the running tool's label
//   is shown while it runs and the turn's tool list stays with its bubble
//   afterwards. One line each, deliberately: the desk is where you go to read a
//   diff, and a phone that tried would be showing you six characters of one.
//
// Attachments are step 6. The seam is `send(text)` taking only text and
// StartTurnInput already having an `attachments` field — nothing here needs to
// change shape to gain a picker, so none was faked.

import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState, type ReactElement } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native';
import { activityLabel } from '@shared/activity';
import type { ActivityItem, ChatMessage } from '@shared/types';
import { useThread } from '../../src/hooks/useThread';
import { AgentMarkdown } from '../../src/ui/AgentMarkdown';
import { ConnectionBadge } from '../../src/ui/ConnectionBadge';
import { isPinnedToBottom } from '../../src/ui/scroll';
import { useTheme, type Theme } from '../../src/ui/theme';

export default function ThreadScreen(): ReactElement {
  const { id } = useLocalSearchParams<{ id: string }>();
  const threadId = String(id ?? '');
  const theme = useTheme();
  const thread = useThread(threadId);
  const [draft, setDraft] = useState('');

  const list = useRef<FlatList<ChatMessage>>(null);
  // A ref, not state: this is read inside a scroll handler that fires many times
  // a second and re-rendering the transcript to record it would be absurd.
  const pinned = useRef(true);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    pinned.current = isPinnedToBottom({
      offsetY: contentOffset.y,
      layoutHeight: layoutMeasurement.height,
      contentHeight: contentSize.height
    });
  }, []);

  const onGrew = useCallback(() => {
    if (pinned.current) list.current?.scrollToEnd({ animated: false });
  }, []);

  const submit = useCallback(() => {
    const text = draft;
    setDraft('');
    thread.send(text);
    // Sending is always a return to the bottom: the thing you just wrote is
    // there, and so is what answers it.
    pinned.current = true;
  }, [draft, thread]);

  const canSend = draft.trim().length > 0 && !thread.blocked && !thread.running && !thread.sending;

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: theme.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 96 : 0}
    >
      <Stack.Screen
        options={{ title: thread.title || 'Chat', headerRight: () => <ConnectionBadge /> }}
      />
      {thread.error ? (
        <Pressable onPress={thread.reload} style={[styles.banner, { borderColor: theme.line }]}>
          <Text style={[styles.bannerText, { color: theme.bad }]}>{thread.error} — tap to retry</Text>
        </Pressable>
      ) : null}
      <FlatList
        ref={list}
        data={thread.state.messages}
        keyExtractor={(message) => message.id}
        contentContainerStyle={styles.transcript}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={onGrew}
        keyboardDismissMode="interactive"
        ListEmptyComponent={
          thread.loading ? (
            <ActivityIndicator style={styles.loading} color={theme.dim} />
          ) : (
            <Text style={[styles.empty, { color: theme.dim }]}>Nothing in this chat yet.</Text>
          )
        }
        ListFooterComponent={
          <LiveActivity
            theme={theme}
            running={thread.running}
            streaming={thread.state.streamingId !== null}
            label={thread.state.activity}
            activities={thread.state.activities}
          />
        }
        renderItem={({ item }) => <Bubble message={item} theme={theme} />}
      />
      <Composer
        theme={theme}
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        onStop={thread.interrupt}
        canSend={canSend}
        running={thread.running}
        blocked={thread.blocked}
      />
    </KeyboardAvoidingView>
  );
}

function Bubble({ message, theme }: { message: ChatMessage; theme: Theme }): ReactElement {
  if (message.role === 'user') {
    return (
      <View style={[styles.userBubble, { backgroundColor: theme.card, borderColor: theme.line }]}>
        <Text style={[styles.userText, { color: theme.text }]}>{message.content}</Text>
        {message.sendFailed ? (
          <Text style={[styles.failed, { color: theme.bad }]}>Not sent</Text>
        ) : null}
      </View>
    );
  }
  if (message.role === 'system') {
    return (
      <View style={[styles.systemBubble, { borderColor: theme.line }]}>
        <Text style={[styles.systemText, { color: theme.bad }]}>{message.content}</Text>
      </View>
    );
  }
  return (
    <View style={styles.agentBubble}>
      {message.activity?.length ? <ActivityRows rows={message.activity} theme={theme} /> : null}
      <AgentMarkdown text={message.content} theme={theme} />
    </View>
  );
}

/** The turn's tool calls, one line each, kept with the bubble they belong to. */
function ActivityRows({ rows, theme }: { rows: ActivityItem[]; theme: Theme }): ReactElement {
  return (
    <View style={styles.activityBlock}>
      {rows.map((row) => (
        <View key={row.id} style={styles.activityRow}>
          <View
            style={[
              styles.activityDot,
              { backgroundColor: row.status === 'error' ? theme.bad : row.status === 'running' ? theme.warn : theme.line }
            ]}
          />
          <Text numberOfLines={1} style={[styles.activityText, { color: theme.dim }]}>
            {activityLabel(row.type, row.name, row.detail)}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The working line, shown between "sent" and the first token. It disappears once
 * text is streaming because the text itself is then the evidence — two live
 * indicators for one turn is one too many.
 */
function LiveActivity({
  theme,
  running,
  streaming,
  label,
  activities
}: {
  theme: Theme;
  running: boolean;
  streaming: boolean;
  label: string | null;
  activities: ActivityItem[];
}): ReactElement | null {
  if (!running || streaming) return null;
  return (
    <View style={styles.live}>
      <ActivityIndicator size="small" color={theme.dim} />
      <Text numberOfLines={1} style={[styles.liveText, { color: theme.dim }]}>
        {label ?? (activities.length ? 'Working…' : 'Thinking…')}
      </Text>
    </View>
  );
}

function Composer({
  theme,
  value,
  onChange,
  onSubmit,
  onStop,
  canSend,
  running,
  blocked
}: {
  theme: Theme;
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  canSend: boolean;
  running: boolean;
  blocked: string | null;
}): ReactElement {
  return (
    <View style={[styles.composer, { borderColor: theme.line, backgroundColor: theme.bg }]}>
      {blocked ? <Text style={[styles.blocked, { color: theme.warn }]}>{blocked}</Text> : null}
      <View style={styles.composerRow}>
        <TextInput
          style={[styles.input, { backgroundColor: theme.card, borderColor: theme.line, color: theme.text }]}
          value={value}
          onChangeText={onChange}
          placeholder={blocked ? 'Can’t send right now' : 'Message Stem'}
          placeholderTextColor={theme.dim}
          editable={!blocked}
          multiline
        />
        {/* Stop replaces Send while a turn runs, rather than sitting beside it:
            the backend refuses a second turn on a busy thread anyway, so a Send
            button there could only ever produce an error. */}
        {running ? (
          <Pressable onPress={onStop} style={[styles.button, { backgroundColor: theme.bad }]}>
            <Text style={styles.buttonText}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={onSubmit}
            disabled={!canSend}
            style={[styles.button, { backgroundColor: canSend ? theme.accent : theme.line }]}
          >
            <Text style={[styles.buttonText, !canSend && { color: theme.dim }]}>Send</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  banner: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  bannerText: { fontSize: 13 },
  transcript: { paddingHorizontal: 16, paddingVertical: 12, gap: 14 },
  loading: { paddingVertical: 40 },
  empty: { fontSize: 14, textAlign: 'center', paddingVertical: 48 },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '86%',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  userText: { fontSize: 16, lineHeight: 22 },
  failed: { fontSize: 12, marginTop: 4 },
  agentBubble: { alignSelf: 'stretch' },
  systemBubble: {
    alignSelf: 'stretch',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  systemText: { fontSize: 14, lineHeight: 20 },
  activityBlock: { gap: 3, marginBottom: 8 },
  activityRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  activityDot: { width: 6, height: 6, borderRadius: 3 },
  activityText: { fontSize: 12, flex: 1 },
  live: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  liveText: { fontSize: 13, flex: 1 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12, gap: 6 },
  blocked: { fontSize: 12, paddingHorizontal: 2 },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 9,
    fontSize: 16,
    maxHeight: 140
  },
  button: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 10 },
  buttonText: { fontSize: 15, fontWeight: '600', color: '#ffffff' }
});
