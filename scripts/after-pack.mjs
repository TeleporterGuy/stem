// electron-builder afterPack hook: prune unreachable onnxruntime binaries,
// then (on macOS) fail the pack if the generated Info.plist is missing the
// Local Network usage description. That key is what lets macOS 15+ prompt;
// a pack without it ships an app whose MCP children fail with errno 65.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import pruneOnnxruntime from './prune-onnxruntime.mjs';
import {
  NS_LOCAL_NETWORK_USAGE_DESCRIPTION,
  NS_LOCAL_NETWORK_USAGE_KEY
} from './macos-info.mjs';

function verifyMacLocalNetworkPlist(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const plist = path.join(context.appOutDir, appName, 'Contents', 'Info.plist');
  if (!existsSync(plist)) {
    throw new Error(`afterPack: packaged Info.plist is missing (${plist})`);
  }
  const printed = execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${NS_LOCAL_NETWORK_USAGE_KEY}`, plist], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  if (printed !== NS_LOCAL_NETWORK_USAGE_DESCRIPTION) {
    throw new Error(
      `afterPack: ${NS_LOCAL_NETWORK_USAGE_KEY} was ${JSON.stringify(printed)}, expected ${JSON.stringify(NS_LOCAL_NETWORK_USAGE_DESCRIPTION)}`
    );
  }
  console.log(`  • ${NS_LOCAL_NETWORK_USAGE_KEY} present in ${appName}`);
}

export default async function afterPack(context) {
  await pruneOnnxruntime(context);
  verifyMacLocalNetworkPlist(context);
}
