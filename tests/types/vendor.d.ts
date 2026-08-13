// Two CommonJS packages that pi-web-access imports and that ship no types. They
// are reachable from the suite only because web-search-latency.test.ts imports
// that package's real `.ts` modules, so its own dependencies get compiled here
// too — see tsconfig.test.json. Declaring them keeps `noImplicitAny` on for
// everything we actually wrote.
declare module 'turndown';
declare module 'promise.try';
