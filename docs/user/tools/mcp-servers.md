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

<!-- TODO(screenshot): MCP servers list showing the eight demo servers, including URL and command examples. -->

## Add a server reached by URL

1. Select **+**, then **URL**.
2. Enter the name and URL supplied by the service. Select **Add Server**.
3. If **Sign in** appears, select it and review the account and permissions.

Most of these need their MCP URL and, where supported, sign-in. Use **Advanced** only
for headers or sign-in details supplied by the service. Put tokens there, not in chat.

Secrets are encrypted when the operating system’s secure storage is available. On
Linux without a keyring, they use an owner-only plaintext file.

## Add a server started by a command

1. Select **+**, then **Command**.
2. Enter its trusted command and arguments.
3. Add required environment variables under **Advanced**, then select **Add Server**.

That command runs wherever your Stem runs. Check its publisher, source, requested
folders, and exact package version first.

## Where a server runs

**Command** and **URL** say how Stem talks to a server, not where it runs. If Stem
runs on the computer you are sitting at, there is only one machine and nothing to
choose.

If Stem runs on a server elsewhere, **Runs on** appears when you add one, and each row
names its place. Pick one of your own computers for a server that only means anything
there — its files, its applications, or a URL on its own network. To move a server that
is already there, select it and choose **Move to** that computer. It starts only after
you approve it on that machine, and its tools then work from anywhere, including your
phone, whenever that computer is awake with Stem running.

Phones are not offered as a place to run a server: they sleep, and the server would be
unreachable half the time.

A server pinned to a computer you later unpair says so and does nothing. Move it to
another computer, pair that one again, or remove it.

## Before you connect

- A server reached by URL may send requests and relevant data to another service. Check
  its scopes, privacy policy, and retention.
- A server started by a command runs as you on whichever machine runs it, inherits
  Stem’s environment, and can reach the files, apps, and network allowed to that
  account.
- Assume Stem can use every tool an enabled server exposes; later calls may not ask
  again.
- Use the least-privileged account or token. Rotate a token pasted into chat.
- When Stem proposes a server, verify the URL or command in the approval card.
  Reject anything unexpected.

The switch stops connecting but keeps the configuration and sign-in. Select the
server and use **−** to remove both.

**Connection failed** can mean expired sign-in, a bad or unreachable URL, or a server
error. Inspect the error, then reconnect or verify the URL and network.
