// Vite serves audio files as hashed asset URLs (ambient file — no imports, so
// the wildcard module declaration stays global).
declare module '*.wav' {
  const url: string;
  export default url;
}
