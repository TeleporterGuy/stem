// Types for the doc generator, so the drift test (tests/unit/shortcuts-doc.test.ts)
// imports a typed module rather than an implicit `any`. The generator itself stays
// plain .mjs: it runs under bare `node`, outside the app's TS build.

/** Absolute path of the generated page, docs/user/shortcuts.md. */
export declare const DOC_PATH: string;

/** The npm script that rewrites the page, for failure messages that tell you the fix. */
export declare const GEN_SCRIPT: string;

/** The page exactly as it should exist on disk. Deterministic: same input, same bytes. */
export declare function renderShortcutsDoc(): string;
