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

That command runs wherever your Stem runs, and starts only if the command exists on
that machine — see [Where a server runs](#where-a-server-runs). Check its publisher,
source, requested folders, and exact package version first.

## Where a server runs

**Command** and **URL** say how Stem talks to a server, not where it runs. A server
runs on the machine Stem itself runs on unless you pin it to one of your computers,
and that machine is the one that has to have its command installed and be able to
reach its URL. If Stem runs on the computer you are sitting at, there is only one
machine and nothing to choose.

If Stem runs on a server elsewhere, **Runs on** appears when you add one, and the list
splits into a section per machine — *On your Stem server*, *On this computer*, and one
for each of your other computers. Pick one of your own computers for a server that only
means anything there: its files, its applications, or a URL on its own network. To move
a server, select it and choose **Move to** that computer, or **Run on the server
instead** to bring it back. It starts only after you approve it on that machine, and its
tools then work from anywhere, including your phone, whenever that computer is awake
with Stem running.

Selecting a server opens everything you can do to it under its own row — how it is
doing, **Test connection**, **Stop trusting**, and where else it could run.

You can also just ask the assistant. It can list your servers and say where each one
runs, which is usually the fastest way to find out why one of them is failing — but
moving a server between machines is yours to do, not something it can do for you.

Phones are not offered as a place to run a server: they sleep, and the server would be
unreachable half the time.

A server pinned to a computer you later unpair moves to a section called **Nowhere —
that computer is gone**, and does nothing until you fix it. Move it to another computer,
pair that one again, or remove it. Pairing a computer again gives it a new identity, so
the same machine paired a second time is a different computer to Stem — the row
remembers the computer it used to mean, and offers that name first when you move it.

**Sign in is not available for a URL server pinned to one of your computers.** Signing
in happens where your Stem server runs, and that machine cannot reach an address on your
home network to do it. Use a static token instead: add an `Authorization: Bearer …`
header to the entry under **Advanced**. That travels with the server's configuration and
works. A URL server that runs on your Stem server signs in as it always has.

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

**Failed to start: spawn … ENOENT** names a command the machine that runs the server
does not have — `spawn uvx ENOENT` means no `uvx` there. Install it on that machine,
or move the server to a computer that already has it. When Stem runs on a server, that
machine is the server, not the computer you are reading this on: a tool installed on
your Mac is not installed for Stem.
