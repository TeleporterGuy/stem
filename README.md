<p align="center">
  <img src="build/icon.png" width="88" alt="">
</p>

<h1 align="center">Stem</h1>

<p align="center">
  A desktop AI assistant that remembers you, reads your folders and runs jobs on a schedule.<br>
  It runs on the ChatGPT or Grok subscription you already pay for, any API key, or a local model.
</p>

<p align="center">
  <a href="https://github.com/join3r/stem/releases/latest"><b>Download</b></a>
  · macOS (Apple Silicon) · Linux (AppImage, deb) ·
  <a href="docs/README.md">User guide</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero-dark.png">
  <img alt="Stem answering from an invoices folder with a stacked bar chart of 2026 billing by client and a client comparison, chats filed into nested folders on the right" src="docs/screenshots/hero-light.png">
</picture>

## Answers you can scan

Replies render as MDX. You get charts, stat tiles, sortable tables, side-by-side comparisons, diagrams, step lists, quizzes and forms when the question calls for one, and a plain paragraph when it doesn't. Any chat can switch to Markdown.

<table>
  <tr>
    <td width="33%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/answer-diagram-dark.png">
        <img alt="A diagram of how dispatch-api deploys, drawn from an Argo CD repo" src="docs/screenshots/answer-diagram-light.png">
      </picture>
    </td>
    <td width="33%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/answer-compare-dark.png">
        <img alt="Stripe Checkout and Payment Element compared side by side, one marked recommended" src="docs/screenshots/answer-compare-light.png">
      </picture>
    </td>
    <td width="33%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/answer-picture-dark.png">
        <img alt="A risograph-style poster for an 18 km Saturday run along the Donaukanal, generated in the chat" src="docs/screenshots/answer-picture-light.png">
      </picture>
    </td>
  </tr>
  <tr>
    <td align="center">Diagrams</td>
    <td align="center">Comparisons</td>
    <td align="center">Pictures, on your ChatGPT plan</td>
  </tr>
</table>

## Memory you can audit

Stem pulls durable facts out of your chats and folders. Each message gets only the facts that matter for it, ranked on your machine by bundled models (the EmbeddingGemma 2 embedder, a Qwen3 reranker and Stem's own GTE Memory model). Every fact shows where it came from and whether the last answer used it. Pin, confirm or forget any of them, or switch memory off.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/memory-dark.png">
  <img alt="A dinner suggestion that respects a vegetarian partner and a peanut allergy, next to the stored facts, the three it used marked Injected" src="docs/screenshots/memory-light.png">
</picture>

Stem also keeps a short summary of you, written from your facts and from how you write, and sends it with every chat that can see your memory. You can edit it or switch it off. A deep check reads every fact against where it came from, fixes what it can prove, and mails you the rest: questions you answer with a click, and facts to keep or retire.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/memory-check-dark.png">
  <img alt="The deep check's mail with a multiple-choice question and facts to keep or retire, next to the summary of you in the Memory tab" src="docs/screenshots/memory-check-light.png">
</picture>

## Your folders, read in place

Connect an Obsidian vault, a repo or a folder of invoices. Stem reads the files where they live and indexes them locally. Say what kind of folder it is (notes, code, documents, confidential) and Stem fills in the settings, or let it look inside and suggest them. Folders are read-only until you allow writes, and you decide per folder whether Stem may learn from it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/folders-dark.png">
  <img alt="An answer about client commitments built from meeting notes, with five connected folders listed on the right" src="docs/screenshots/folders-light.png">
</picture>

## Personas and mail

A persona is a saved setup: instructions, model, tools, MCP servers, memory, a coding agent or a computer it may drive. You mail it like a colleague and the reply lands in the Inbox, newest on top. Scheduled tasks report here too, and only when they found something.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/mail-dark.png">
  <img alt="The Bookkeeper persona's reply naming an overdue invoice with a reminder draft, the Inbox on the right" src="docs/screenshots/mail-light.png">
</picture>

A persona allowed to start helpers splits a big job. It starts named agents from your other personas, each works one piece, and you get one answer with their mails folded in under it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/mail-agents-dark.png">
  <img alt="The Secretary's answer about a client demo, with the mail from the billing agent it started unfolded underneath" src="docs/screenshots/mail-agents-light.png">
</picture>

## Quick Chat

A global shortcut opens Quick Chat over whatever app you're in. Ask, hit Enter, and it gets out of the way. A pill in the corner tells you when the answer is ready.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/quick-chat-dark.png">
    <img alt="The Quick Chat overlay with a running pace table" src="docs/screenshots/quick-chat-light.png" width="596">
  </picture>
  <br>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/status-hud-dark.png">
    <img alt="The pill announcing the answer is ready" src="docs/screenshots/status-hud-light.png" width="209">
  </picture>
</p>

## Also in the box

- **Coding agents.** A persona hands work to Claude Code or any other ACP agent, on the server or on one of your computers. The agent's permission requests arrive as cards in the chat.
- **Computer control (alpha).** A persona pinned to your Mac can work in its apps, including windows on another Space or behind other windows. macOS 14 or newer.
- **Skill recorder (alpha).** Record yourself doing a task on the Mac. Stem writes it up as a draft skill, and a practice run tries it before you save it.
- **Browser control.** The Stem extension for Chrome, Arc, Dia, Brave, Edge and Chromium lets Stem use your own signed-in browser in background tabs.
- **Scheduled tasks.** Ask for "every weekday at 8, check…" and you get a cron job. Each run starts in a fresh thread.
- **Shell commands.** A safety check runs what you asked for and turns the rest back. You decide only after repeated refusals, and you can always allow commands by name or pattern.
- **MCP servers and skills.** Add MCP servers by command or URL, OAuth included. Stem writes skills from work that went well and rewrites the ones that failed.
- **Pinboard.** Pin a message, a highlighted phrase or your own note to the top of a chat. Stem keeps the board in context for the rest of that chat.
- **Private chats.** A private chat doesn't read your memory and teaches it nothing.
- **Dictation.** The mic button transcribes with Apple's on-device speech models; the audio never leaves the Mac. macOS 26 or newer.
- **Long chats.** `/compact` condenses a chat's history when it gets long, with an optional focus for what to keep.
- **Themes.** Light, dark, bundled themes, or a JSON file of your own that can also set fonts and spacing.

<table>
  <tr>
    <td width="33%"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/panel-models-dark.png"><img alt="Settings, Models: the ChatGPT provider and model roles" src="docs/screenshots/panel-models-light.png"></picture></td>
    <td width="33%"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/panel-features-dark.png"><img alt="Settings, Features: mail, image generation, commands, coding agents" src="docs/screenshots/panel-features-light.png"></picture></td>
    <td width="33%"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/panel-personas-dark.png"><img alt="The Bookkeeper persona's Access tab: private memory, your memory, helpers, MCP servers, send budget" src="docs/screenshots/panel-personas-light.png"></picture></td>
  </tr>
  <tr>
    <td align="center">Models</td>
    <td align="center">Features</td>
    <td align="center">A persona</td>
  </tr>
  <tr>
    <td width="33%"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/panel-tasks-dark.png"><img alt="Four scheduled tasks with their schedules, personas and next runs" src="docs/screenshots/panel-tasks-light.png"></picture></td>
    <td width="33%"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/panel-task-runs-dark.png"><img alt="A scheduled task's last three runs, none of which needed to mail" src="docs/screenshots/panel-task-runs-light.png"></picture></td>
    <td width="33%"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/panel-folder-editor-dark.png"><img alt="A connected folder's search and learning settings" src="docs/screenshots/panel-folder-editor-light.png"></picture></td>
  </tr>
  <tr>
    <td align="center">Scheduled tasks</td>
    <td align="center">A task's runs</td>
    <td align="center">A connected folder</td>
  </tr>
  <tr>
    <td width="33%"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/panel-mcp-dark.png"><img alt="Two MCP servers, one command and one URL, both running" src="docs/screenshots/panel-mcp-light.png"></picture></td>
    <td width="33%"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/panel-skills-dark.png"><img alt="Skills Stem saved, with the setting for when it may save new ones" src="docs/screenshots/panel-skills-light.png"></picture></td>
    <td width="33%"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/panel-folders-dark.png"><img alt="Five connected folders: two notes vaults, two code folders and a confidential one" src="docs/screenshots/panel-folders-light.png"></picture></td>
  </tr>
  <tr>
    <td align="center">MCP servers</td>
    <td align="center">Skills</td>
    <td align="center">Connected folders</td>
  </tr>
</table>

## Models

| Provider | How you connect |
| --- | --- |
| ChatGPT, Grok | Sign in with your subscription |
| Anthropic, OpenAI, OpenRouter, xAI | API key |
| Ollama, LM Studio | Local server, no key |
| Anything OpenAI- or Anthropic-compatible | Custom endpoint |

A Claude subscription doesn't cover Stem. Anthropic bills third-party apps from your extra usage, not your plan limits, so use an Anthropic API key for Claude models.

Switch models per chat, mid-conversation. Web search works with every model and cites its sources; a ChatGPT or Grok sign-in covers it without a separate search key.

## Run it on a server

By default Stem runs on your computer. Move it to a VPS with Docker and Caddy, or to a box on your Tailscale network, and every Mac, Linux machine and the iPhone app (beta) becomes a client of that one Stem. They share chats, memory and tasks, and scheduled runs fire while the laptop is closed. An MCP server or folder that only makes sense on your laptop stays pinned to it.

[Running on a server](docs/running-on-a-server.md) · [Running on a LAN or Tailscale](docs/running-on-tailscale.md)

## Install

Grab the latest build from [Releases](https://github.com/join3r/stem/releases/latest):

- **macOS.** `.dmg` for Apple Silicon, signed and notarized.
- **Linux.** `.AppImage` for any distro, or `.deb` for Debian and Ubuntu (also puts `stem` on your PATH). Both for x64 and arm64.

First launch walks you through signing in to a provider.

<details>
<summary>Linux notes</summary>

- **Quick Chat on Wayland.** Electron's global shortcuts don't fire in default GNOME and KDE sessions. Bind a system shortcut to `stem --quick-chat` (deb) or `/path/to/Stem.AppImage --quick-chat`; a second launch hands the toggle to the running app. On X11 the in-app shortcut works.
- **Tray.** The tray icon offers Summon Quick Chat, Open Stem and Quit. Stock GNOME hides tray icons without the [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/); running `stem` again reopens the main window.
- **Closing the window** leaves Stem running in the background. Quit from the tray.
- **Secrets** are encrypted with the system keyring (`libsecret` or kwallet). Without one, Stem falls back to files readable only by your user (mode 0600).

</details>

## Build from source

Node.js 24 or newer, then `npm install && npm run dev`. Scripts, Windows and the rest are in [docs/development.md](docs/development.md).
