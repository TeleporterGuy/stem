// Re-hash the files latest-mac.yml lists, after the release job has changed
// their bytes.
//
// electron-builder writes latest-mac.yml (the feed electron-updater reads on a
// mac) while it builds, and the release job staples the DMG's notarization
// ticket afterwards (scripts/notarize-mac-dmg.sh) — which rewrites the DMG.
// The feed's sha512/size for the DMG then describe bytes nobody can download.
// electron-updater only ever fetches the zip on a mac, so a stale DMG entry
// would be harmless today, but a feed that lies about one file is a trap for
// whoever trusts it next. So: every listed file is hashed again from disk; a
// file whose bytes changed loses its blockMapSize too, since the .blockmap
// beside it was computed from the old bytes and is not published.
//
// Usage: node scripts/refresh-mac-update-feed.mjs release/latest-mac.yml
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

const feedPath = process.argv[2];
if (!feedPath) {
  console.error('Usage: node scripts/refresh-mac-update-feed.mjs path/to/latest-mac.yml');
  process.exit(1);
}
const dir = path.dirname(feedPath);

/** The digest electron-builder writes: sha512, base64. */
function sha512(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('base64')));
  });
}

// Edited as a document, not re-serialized from a plain object: the rest of the
// feed keeps electron-builder's formatting — releaseDate stays a quoted string
// rather than an unquoted timestamp a YAML 1.1 reader would turn into a Date.
const doc = YAML.parseDocument(await readFile(feedPath, 'utf8'));
const feed = doc.toJS();
if (!Array.isArray(feed?.files) || feed.files.length === 0) {
  throw new Error(`${feedPath} lists no files`);
}
if (!feed.files.some((f) => f.url.endsWith('.zip'))) {
  // The one file a mac updater downloads; without it the feed is useless.
  throw new Error(`${feedPath} lists no zip`);
}

let changed = false;
for (const [i, entry] of feed.files.entries()) {
  const file = path.join(dir, entry.url);
  const [digest, { size }] = await Promise.all([sha512(file), stat(file)]);
  if (digest === entry.sha512 && size === entry.size) continue;
  console.log(`refreshed ${entry.url} (bytes changed after the feed was written)`);
  doc.setIn(['files', i, 'sha512'], digest);
  doc.setIn(['files', i, 'size'], size);
  doc.deleteIn(['files', i, 'blockMapSize']);
  // The legacy top-level pair mirrors the entry for `path`.
  if (entry.url === feed.path) doc.set('sha512', digest);
  changed = true;
}

if (changed) await writeFile(feedPath, doc.toString({ lineWidth: 0 }));
console.log(`${feedPath} matches the files beside it.`);
