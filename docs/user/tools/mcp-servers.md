# MCP servers

← [Stem guide](../../README.md) · [Tools](README.md)

Examples only. Stem does not bundle these. Add a compatible MCP server from a
provider you trust.

| Example | Possible use |
| --- | --- |
| **Gmail** | Find client email; draft a reply |
| **Calendar** | Check availability; prepare for a meeting |
| **Todoist** | Capture tasks; review work due today |
| **Slack** | Find a project decision; summarize a thread |
| **Jira** | Find or update project issues |
| **Grafana** | Inspect dashboards; investigate an alert |
| **Home Assistant** | Check home status; run a chosen automation |
| **Chrome DevTools** | Inspect a web app; diagnose console and network errors |

MCP servers give Stem tools from another service or program. No protocol knowledge
needed. Exact actions depend on the server and its account permissions.

Open **Tools → MCP servers**.

<!-- TODO(screenshot): MCP servers list showing the eight demo servers, including remote and local examples. -->

## Add a remote server

1. Select **+**, then **Remote**.
2. Enter the name and URL supplied by the service. Select **Add Server**.
3. If **Sign in** appears, select it and review the account and permissions.

Most remote MCP servers need their MCP URL and, where supported, sign-in. Use
**Advanced** only for headers or sign-in details supplied by the service. Put tokens
there, not in chat.

Secrets are encrypted when the operating system’s secure storage is available. On
Linux without a keyring, they use an owner-only plaintext file.

## Add a local server

1. Select **+**, then **Local**.
2. Enter its trusted command and arguments.
3. Add required environment variables under **Advanced**, then select **Add Server**.

A local server runs that command on your computer. Check its publisher, source,
requested folders, and exact package version first.

## Before you connect

- Remote tools may send requests and relevant data to another service. Check its
  scopes, privacy policy, and retention.
- Local tools run as you, inherit Stem’s environment, and can reach files, apps, and
  the network allowed to your account.
- Assume Stem can use every tool an enabled server exposes; later calls may not ask
  again.
- Use the least-privileged account or token. Rotate a token pasted into chat.
- When Stem proposes a server, verify the URL or command in the approval card.
  Reject anything unexpected.

The switch stops connecting but keeps the configuration and sign-in. Select the
server and use **−** to remove both.

**Connection failed** can mean expired sign-in, a bad or unreachable URL, or a server
error. Inspect the error, then reconnect or verify the URL and network.
