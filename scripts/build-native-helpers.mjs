// electron-builder's beforePack: the computer-control helper for the platform
// being packed — the Swift one for a Mac (build-mac-helper.mjs), the C# one for
// Windows (build-windows-helper.mjs). Linux has no native helper.
import { buildHelper as buildMac } from './build-mac-helper.mjs';
import { buildHelper as buildWindows } from './build-windows-helper.mjs';

export default async function beforePack(context) {
  if (context.electronPlatformName === 'darwin') buildMac();
  if (context.electronPlatformName === 'win32') buildWindows();
}
