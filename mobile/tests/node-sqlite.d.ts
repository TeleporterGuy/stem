// Just enough of node:sqlite for the offline-cache test, declared here rather
// than pulled in with @types/node.
//
// The app has no Node types on purpose: it is a React Native bundle, and a
// project where `import { readFileSync } from 'node:fs'` typechecks is a project
// where someone eventually ships one to a phone. The TEST runtime is Node
// though (see vitest.config.mts), and node:sqlite is a real SQL engine that is
// already there — so the offline cache's SQL can be exercised for real without
// adding a dependency, or Node's globals, to the app.

declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(source: string): void;
    prepare(source: string): {
      run(...params: unknown[]): unknown;
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  }
}
