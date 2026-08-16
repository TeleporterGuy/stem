// `import text from './thing.md?raw'` — vite inlines the file's bytes as a string
// at build time. Used to ship docs/ inside the bundles (see recall/stem-guide.ts);
// tsc knows nothing about vite's query suffixes, so declare the shape here.
// Ambient file — no top-level imports, or the declaration stops being global.
declare module '*.md?raw' {
  const content: string;
  export default content;
}
