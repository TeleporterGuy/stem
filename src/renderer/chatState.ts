// Moved to src/shared/chatState.ts when the phone became a second client of the
// same fold (Phase 4). Kept as a re-export rather than rewritten at every call
// site: the renderer's session code imports this path in a dozen places and none
// of those imports say anything different now than they did before.

export * from '../shared/chatState';
