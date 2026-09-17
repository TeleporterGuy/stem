// macOS Info.plist keys that Stem's packaging and the dev Electron.app brand
// script must agree on. Extra keys are ignored on older macOS; missing
// NSLocalNetworkUsageDescription on 15+ means the system cannot prompt, so
// MCP children fail with errno 65 ("No route to host") and Stem never appears
// under Privacy & Security → Local Network.

export const NS_LOCAL_NETWORK_USAGE_KEY = 'NSLocalNetworkUsageDescription';

export const NS_LOCAL_NETWORK_USAGE_DESCRIPTION =
  'Stem connects to services and MCP integrations running on your local network, such as Home Assistant.';
