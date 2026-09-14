import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AgentMarkdown } from '../ui/AgentMarkdown';
import type { Theme } from '../ui/theme';

/**
 * A code persona's mail: the coding agent's own reply (or replies), verbatim,
 * collapsed under the persona's relay of it — MailItem.agentReplies.
 */
export function AgentReplies({ replies, theme }: { replies: string[]; theme: Theme }) {
  const [expanded, setExpanded] = useState(false);
  const label = replies.length === 1 ? 'as received' : `${replies.length} exchanges, as received`;
  return (
    <View style={{ borderWidth: 1, borderColor: theme.line, borderRadius: 10, padding: 10, gap: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((open) => !open)}
        style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}
      >
        <Text style={{ color: theme.text, fontWeight: '600' }}>{expanded ? '▾' : '▸'} Coding agent’s reply</Text>
        <Text style={{ color: theme.dim, fontSize: 12 }}>{label}</Text>
      </Pressable>
      {expanded &&
        replies.map((text, index) => (
          <View
            key={index}
            style={index > 0 ? { borderTopWidth: 1, borderTopColor: theme.line, paddingTop: 10 } : undefined}
          >
            <AgentMarkdown text={text} theme={theme} />
          </View>
        ))}
    </View>
  );
}
