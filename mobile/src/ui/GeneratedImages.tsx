import { File, Paths } from 'expo-file-system';
import { useEffect, useState, type ReactElement } from 'react';
import { Image, Modal, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import type { ActivityItem, GeneratedImageRef } from '@shared/types';
import { useTransport } from '../transport/provider';
import type { Theme } from './theme';

// Pictures generate_image made, under the agent's reply. History and events
// carry refs only; each card fetches its bytes once over `chats:image` and
// keeps them in a small in-memory cache (the desktop's rule), so scrolling
// back through a thread doesn't refetch megabytes.

const CACHE_MAX_ENTRIES = 24;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

function remember(key: string, dataUrl: string): void {
  cache.delete(key);
  cache.set(key, dataUrl);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

type Rpc = (channel: string, ...args: unknown[]) => Promise<unknown>;

function useChatImage(ref: GeneratedImageRef): string | null | undefined {
  const { connection } = useTransport();
  const key = `${ref.threadId}/${ref.id}`;
  const [url, setUrl] = useState<string | null | undefined>(() => cache.get(key));
  useEffect(() => {
    let live = true;
    const hit = cache.get(key);
    if (hit) {
      setUrl(hit);
      return;
    }
    let pending = inflight.get(key);
    if (!pending) {
      pending = (connection.rpc as Rpc)('chats:image', ref.threadId, ref.id)
        .then((res) => {
          const dataUrl = (res as { dataUrl?: string } | null)?.dataUrl ?? null;
          if (dataUrl) remember(key, dataUrl);
          return dataUrl;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    pending.then(
      (u) => live && setUrl(u),
      () => live && setUrl(null)
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ref's identity
  }, [key, connection]);
  return url;
}

/** The picture as a file in the cache folder — what the share sheet and drafts take. */
function writeTempImage(image: GeneratedImageRef, dataUrl: string): File {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('Not an image.');
  const ext = m[1] === 'image/jpeg' ? 'jpg' : 'png';
  const file = new File(Paths.cache, `stem-${image.id}.${ext}`);
  if (!file.exists) {
    file.create({ intermediates: true, overwrite: true });
    file.write(m[2], { encoding: 'base64' });
  }
  return file;
}

function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function PendingCard({ item, live, theme }: { item: ActivityItem; live: boolean; theme: Theme }): ReactElement {
  const [firstSeen] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return (
    <View style={[styles.card, styles.pending, { borderColor: theme.line }]} accessibilityLiveRegion="polite">
      <Text style={{ color: theme.dim }}>
        {live ? `Creating image…  ${elapsed(item.startedAt ?? firstSeen, now)}` : 'Stopped before the image was ready'}
      </Text>
    </View>
  );
}

function ImageCard({
  image,
  theme,
  onUseAsReference
}: {
  image: GeneratedImageRef;
  theme: Theme;
  onUseAsReference?: (file: { uri: string; name: string; mime: string }) => void;
}): ReactElement {
  const { connection } = useTransport();
  const url = useChatImage(image);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const alt = image.revisedPrompt || image.prompt || 'Generated image';
  const ratio = image.width && image.height ? image.width / image.height : 1;
  const say = (text: string) => {
    setNote(text);
    setTimeout(() => setNote((cur) => (cur === text ? null : cur)), 2000);
  };
  if (url === null) {
    return (
      <View style={[styles.card, { borderColor: theme.line }]}>
        <Text style={{ color: theme.dim }}>This image is no longer available</Text>
      </View>
    );
  }
  const share = () => {
    if (!url) return;
    try {
      const file = writeTempImage(image, url);
      // A share sheet presented over a Modal leaves iOS unable to present the
      // Modal again afterwards; close the viewer first, share once it's gone.
      setOpen(false);
      setTimeout(() => void Share.share({ url: file.uri }), 450);
    } catch (e) {
      say(String((e as Error)?.message ?? e));
    }
  };
  const saveToFiles = () =>
    (connection.rpc as Rpc)('chats:saveImageToFiles', image.threadId, image.id).then(
      () => say('Saved to Files'),
      (e) => say(String((e as Error)?.message ?? e))
    );
  const reference = () => {
    if (!url || !onUseAsReference) return;
    try {
      const file = writeTempImage(image, url);
      onUseAsReference({ uri: file.uri, name: `${image.id}.png`, mime: image.mime });
      setOpen(false);
    } catch (e) {
      say(String((e as Error)?.message ?? e));
    }
  };
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => url && setOpen(true)}
        accessibilityRole="imagebutton"
        accessibilityLabel={alt}
        style={[styles.frame, { aspectRatio: ratio, borderColor: theme.line }]}
      >
        {url ? <Image source={{ uri: url }} style={styles.fill} resizeMode="contain" /> : null}
      </Pressable>
      {note ? <Text style={[styles.note, { color: theme.dim }]}>{note}</Text> : null}
      <Modal visible={open} animationType="fade" transparent onRequestClose={() => setOpen(false)}>
        <View style={styles.backdrop}>
          <Pressable style={styles.fill} onPress={() => setOpen(false)} accessibilityLabel="Close">
            {url ? <Image source={{ uri: url }} style={styles.fill} resizeMode="contain" accessibilityLabel={alt} /> : null}
          </Pressable>
          <View style={styles.actions}>
            <ActionButton label="Share" onPress={share} />
            <ActionButton label="Save to Files" onPress={() => void saveToFiles()} />
            {onUseAsReference ? <ActionButton label="Use as reference" onPress={reference} /> : null}
            <ActionButton label="Close" onPress={() => setOpen(false)} />
          </View>
          {note ? <Text style={styles.modalNote}>{note}</Text> : null}
        </View>
      </Modal>
    </View>
  );
}

function ActionButton({ label, onPress }: { label: string; onPress: () => void }): ReactElement {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={styles.action}>
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

/** Every picture of one agent turn, then a placeholder per call still running. */
export function GeneratedImages({
  images,
  activity,
  live,
  theme,
  onUseAsReference
}: {
  images?: GeneratedImageRef[];
  activity?: ActivityItem[];
  live: boolean;
  theme: Theme;
  onUseAsReference?: (file: { uri: string; name: string; mime: string }) => void;
}): ReactElement | null {
  const done = images ?? [];
  const pending = (activity ?? []).filter((a) => a.type === 'imageGeneration' && a.status === 'running');
  if (!done.length && !pending.length) return null;
  return (
    <View style={styles.list}>
      {done.map((img) => (
        <ImageCard key={img.id} image={img} theme={theme} onUseAsReference={onUseAsReference} />
      ))}
      {pending.map((a) => (
        <PendingCard key={a.id} item={a} live={live} theme={theme} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10, marginTop: 8 },
  wrap: { alignSelf: 'stretch' },
  frame: { width: '100%', maxHeight: 420, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  fill: { flex: 1, width: '100%', height: '100%' },
  card: {
    alignSelf: 'stretch',
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderRadius: 10,
    padding: 14
  },
  pending: { aspectRatio: 1.4, alignItems: 'center', justifyContent: 'center' },
  note: { fontSize: 12, marginTop: 4 },
  backdrop: { flex: 1, backgroundColor: '#000', paddingTop: 60, paddingBottom: 30 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 12 },
  action: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.16)' },
  actionText: { color: '#fff', fontSize: 15 },
  modalNote: { color: '#fff', textAlign: 'center', marginTop: 8 }
});
