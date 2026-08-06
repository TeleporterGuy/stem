// Wrapper for running the bundled pi CLI under Electron-as-Node
// (ELECTRON_RUN_AS_NODE). pi sets process.title, and libuv's title setter on
// macOS checks the process into LaunchServices — because the executable lives
// inside Electron.app, that registers a foreground app that never finishes
// launching: a bouncing, force-quit-only "Electron" Dock icon per pi process.
// Freezing the title before pi loads keeps this headless child out of the Dock.
// (Verified empirically: `Electron -e "process.title='x'"` under
// ELECTRON_RUN_AS_NODE registers with LaunchServices; without the assignment it
// does not.)
import { pathToFileURL } from 'node:url';

const title = process.title;
Object.defineProperty(process, 'title', {
  configurable: true,
  get: () => title,
  set: () => {}
});

// Drop this shim from argv so pi's CLI sees exactly the argv shape of a direct
// `node cli.js …` spawn (script at argv[1], flags from argv[2]).
process.argv.splice(1, 1);
await import(pathToFileURL(process.argv[1]).href);
