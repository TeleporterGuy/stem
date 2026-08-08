# Stem release notes

What's changed in each version, in plain language. Stem shows the new entries once, the first
time you open it after an update — you can turn that off in Settings → About.

<!--
Maintainer notes:
- One `## <version> — <date>` section per release, newest first. The version is the first token
  after `##`; everything after the dash is free text ("Unreleased" while a release is in flight).
- Stem hides any section newer than the running app version, so notes can land here before the
  release is cut. Cutting a release = bump `version` in package.json, swap "Unreleased" for the
  date, tag.
-->

## 0.4.0 — Unreleased

### Added

- **An Inbox for your chats.** The chat list now has two tabs — Inbox and Chats — and the Inbox
  works like mail. Every thread waits there until you archive it or snooze it for later, and a
  thread that has something new in it — a scheduled task that ran overnight, a reply you never came
  back to — shows in bold with a count on the Chats tab. Unread survives quitting the app. Snoozed
  and archived threads sit in groups at the foot of the list, snoozed ones showing the time they
  come back, and anything new in a snoozed or archived thread brings it straight back to the Inbox.
  Archiving only affects the Inbox: the thread stays exactly where it was in your folders and still
  turns up in search. Hold ⌘ to pick several threads and archive or snooze them in one go. Dealing
  with the thread you're reading moves you straight on to the next one waiting — and to a new chat
  when there's nothing left, so an empty Inbox leaves you ready to write.
- **Chats name themselves properly.** Instead of taking the first line of whatever you typed, Stem
  writes each new chat a short subject from your opening message — and uses it as the chat's name,
  so the list, search and the window title all agree. A name you type yourself is never overwritten,
  and "Write a subject" on any chat's right-click menu does one on demand. Settings → Chats picks
  the model, or turns the whole thing off.
- **Inbox rows show what's in them.** Under each subject, a line or two of the newest message in the
  thread, so you can tell what's waiting without opening it. Settings → Chats sets how many lines,
  or none at all.
- **Devices.** Settings → Devices lists everything signed in to your Stem — what it's called, when
  it last connected — and lets you withdraw any of them, which takes effect immediately rather than
  the next time that device asks for something. Adding one works like a door code: you get an
  eight-character code, valid for ten minutes and one device, and type it on the machine you're
  adding. Stem no longer keeps a copy of any device's key, only enough to recognise it, so a key can
  be withdrawn but never read back out — not by you, and not by anyone who gets hold of the files.
  Nothing changes for the Mac you're reading this on: it signs itself in, as it always has.
- **Point Stem at a server somewhere else.** Settings → Server is new. By default Stem runs its own
  server on the computer you're using and nothing leaves the machine — that hasn't changed. But you
  can now enter the address of a Stem running elsewhere and a code from it, and this app becomes a
  window onto that one: same chats, same memory, same skills, from any machine you sit at. Stem
  connects when it starts, so the move takes effect the next time you open it, and the pane says so.
  There's a button to come back to this computer's own server whenever you want. If you want to *be*
  that server, [Running on a server](docs/running-on-a-server.md) walks the whole move — your own
  domain, HTTPS, and your Mac paired to it — and tells you how to go back.
- **Signing in still works when Stem is on another computer.** Connecting an account — Claude,
  ChatGPT, an MCP tool that asks you to log in — finishes in a browser, and browsers hand the
  result back to the machine they're running on. When Stem's brain is elsewhere, that used to be
  the wrong machine and the sign-in simply hung. Now the app opens the page for you, catches what
  the browser brings back and passes it along, so connecting an account from a laptop feels exactly
  the way it does when Stem is running right there. Signing in with a code you confirm on a phone
  or another device is unaffected, and if anything goes wrong you can still paste the address your
  browser ended up on.
- **Your shortcut and your window settings stay with your machine.** The Quick Chat key, whether the
  overlay floats across every Space, whether the progress pill follows you, and which release notes
  you've already read are now kept per computer rather than shared. So a laptop and a desktop
  pointed at the same Stem can each have their own summon key, and neither is told about a new
  version until it actually has it. Everything already set carries over untouched.
- **Attaching files works when Stem is on another computer.** Attaching something to a message, or
  dropping it into your Files folder, used to tell Stem's server where the file was on your disk —
  which is only useful when that is the same disk. Now the file itself is sent across, so
  attachments and drops behave the same wherever Stem is running. Files come back the same way:
  every file in your Files folder has a Download button that saves a copy into your Downloads
  folder and shows it there. And when Stem's server isn't this computer, the buttons that opened a
  folder in Finder — your Files folder, Stem's own folder, and each connected folder — are no
  longer offered, because none of those folders are here to open.
- **An answer being written while you're offline is still there when you come back.** Close the lid
  in the middle of a reply, lose the wifi, walk out of range — Stem's server carries on writing, and
  when the app reconnects it asks for what it missed and fills the answer in to the end. If you were
  away too long for that, it fetches the conversation fresh instead, which comes to the same thing.
  Either way a reply that finished while you were gone shows as finished, and one that is still
  being written shows as still running, rather than a spinner that never stops or an answer that
  stops mid-sentence.
- **Your chats are readable with no connection at all.** When Stem's server is on another computer,
  this one now keeps its own copy of your recent conversations, topped up quietly in the background
  as you work. So Stem opens on a train, in a tunnel, or with the wifi off, and your chat list and
  the conversations themselves are there to read. It says plainly at the top of the window that it
  can't reach the server, and the message box is switched off rather than taking something it has no
  way to send. Memory, skills and chat search say they need the server rather than showing up empty,
  which would look like you'd lost them. The moment the connection comes back, everything refreshes
  on its own. Nothing changes when Stem's server is on the computer you're using: it's already here,
  so there's nothing to keep a copy of.
- **Take your whole Stem with you, or keep a copy of it.** Settings → Server has a new "Move or back
  up this Stem", which writes everything Stem knows — your chats, your memory, your skills, your
  Files, your settings and the tools you've connected — into one file. Carry it to another computer
  or a server, run `stem-server import` there, and it's the same Stem: same conversations, same
  memory, same connected tools still signed in. Keep the file instead and it's a backup, restored by
  exactly the same command. You choose a passphrase when you export, and that passphrase is what
  unlocks your connected tools on the other side, so keep it with the copy. Some things deliberately
  stay behind and Stem lists them for you: the devices paired with the old one (you pair afresh),
  this computer's own shortcut and window settings, and about a gigabyte of downloaded models that
  simply download again. What was made out of your own files — including the search indexes over
  your connected folders — always comes along. Importing tells you what landed and what needs you,
  and refuses point-blank to unpack over a Stem that has already been used rather than mixing the
  two together.

### Removed

- **The phone client is gone, for now.** Settings → Mobile, the pairing QR and the web app you
  opened on your phone have all been removed, and a phone you had paired stops working — its
  pairing code no longer opens anything. The reason is what comes next: Stem's brain is moving to
  a server you can reach from anywhere, and the phone app that talks to it is being built properly
  rather than kept limping in the meantime. Nothing about Stem at the desk changes.

## 0.3.0 — 2026-08-04

### Added

- **Skills that earn their place.** Skills are rebuilt around what the assistant actually did —
  the real tool trace of a turn, not its narration of one — and are checked against a contract
  before they are saved. Stem now picks the few skills relevant to your message instead of
  broadcasting every description at every turn.
- **Memory that keeps itself true.** A new fact is checked against what Stem already knows, so an
  outdated one is retired even when it is worded nothing like its replacement. Merging facts keeps
  the dates they were asserted on, and disagreements Stem can settle on its own are settled.
- **Sign in with xAI (Grok).** Grok joins ChatGPT, Claude, OpenRouter and the local servers in the
  provider list, with the same in-app sign-in.
- **Grok web search.** Grok can now be picked as the backend Stem searches the web with.
- **Custom OpenAI-compatible endpoint.** Point Stem at any server that speaks the OpenAI API —
  your own proxy, a hosted gateway, a colleague's box — and pick which models it offers. Endpoints
  that speak the Anthropic Messages API work too; Stem detects which one yours is.
- **A clearer search picker.** The backend list is grouped by what's actually ready to use (works
  on your sign-in / needs a key / not configured), and the assistant is told which backend it is
  searching with, so citations name the right source.
- **Web search is faster.** Several queries now run at once, pages are fetched in batches, and the
  model that runs the search itself was swapped for a quicker one — the answers and sources held
  up in benchmarking, because the thinking happens in your chat model afterwards either way.
- **This popup.** Stem shows what changed once, the first time you open it after an update.
  Settings → About turns it off and keeps the full history.

### Fixed

- **Memory no longer argues with itself.** Conflicting facts are raised and resolved at rates that
  actually match, a fact retired by mistake can't quietly come back, and "Reset recall" is now a
  hard stop — a background pass that was already running can't resurrect anything after it.
- **Memory works without embeddings.** When the local embedding model is off or still loading, the
  keyword-only fallback keeps its promises instead of silently dropping results or ranking your
  documents backwards.
- **"Memory used in this chat" tells the truth about the past.** A conflict raised (or resolved)
  after a turn no longer rewrites what that turn is shown to have been told.
- **A reply that arrives in several pieces stays whole** instead of losing everything but the last
  piece.
- **Running commands is steadier.** The safety check no longer times out or runs on the expensive
  model, it says why it refused without pasting an exception at you, and it reads Windows paths
  and PowerShell quoting correctly.
- **Stem now starts properly on Linux.** First run off macOS could fail outright; the installer
  also now fetches the Electron runtime it needs. The Linux x64 download is roughly half the size
  it was.
- **Quick Chat opens on the Space you're actually on**, instead of pulling you back to the one it
  was last summoned from.
- **Your phone can no longer read files or API keys off your Mac.** The phone bridge was exposing
  more of Stem's internals than it should; it is now limited to the chat surface it needs.
- **A web-search key you edit takes effect immediately** rather than only being saved.
- **Disconnecting a provider sticks.** Two provider changes at once could resurrect a
  just-disconnected one.
- **A slow connection test can't overwrite a newer one's result** in Settings, so the ✓/✗ you see
  belongs to the endpoint you're looking at.
- **A phone reply that finishes very fast no longer stalls scheduled tasks** for the rest of the
  session.
- **One misconfigured provider no longer breaks every chat** — Stem starts without it instead of
  refusing to start at all.

## 0.2.0 — 2026-07-29

### Added

- **Stem on your phone.** An opt-in bridge (Settings → Mobile) serves a small Stem client to your
  phone over your tailnet, so you can carry on a conversation away from the desk.
- **Web search on every provider.** Search no longer depends on which model you signed in with —
  it works out of the box on a fresh install, with citations, and you can point it at your own
  backend or key.
- **An activity surface.** Stem shows what it's doing while it works — which tool is running, when
  context is being compacted — instead of a silent spinner.
- **Run commands.** The assistant can run shell commands for you, behind a tiered approval system:
  a learned allowlist, then a judge model, then an approval card for anything it isn't sure about.
  Off-limits paths are always protected, and you can set the mode (assisted / manual / yolo) in
  Settings.
- **Connected folders feed memory.** Folders you connect are indexed and Stem learns durable facts
  from them, so it can answer from your own documents.
- **Files gets its own tab**, separate from connected folders.
- **Fact conflicts resolve themselves.** When two remembered facts disagree, Stem classifies the
  conflict and picks a resolution instead of quietly keeping both.
- **Checklists you can tick.** Task lists in a reply are interactive.
- **Skills track their own usage**, so the ones that actually get consulted are visible.
- **An end-user guide** covering chats, memory, folders and tools (`docs/user`).

### Fixed

- Scheduled runs keep the model the thread was using, and recover instead of failing when a run
  overflows its context.
- Typing in the composer no longer re-renders the whole conversation on long threads.
- Reopened chats show the model and effort each reply was produced with again.

## 0.1.0 — 2026-07-20

The first release. Stem is a private, local-first assistant that runs on your own AI sign-in:

- **Chats** with nested folders, search across every conversation, per-message retry / edit /
  fork, attachments and image paste, and several chats answering at once.
- **Quick Chat**, a global-shortcut overlay for a question you don't want to open a window for,
  plus a status pill that follows you across Spaces.
- **Stem Recall**, a memory system that is yours rather than the model vendor's: durable facts,
  episodic recall, relevance ranking with local embeddings, and full control to inspect, pin,
  correct or erase anything it has remembered.
- **Rich replies.** Answers render as MDX — tabs, tables, charts, quizzes and forms, not just a
  wall of text — with a plain-Markdown mode when you want one.
- **Your tools.** MCP servers (local and remote, with in-app OAuth), read/write file access to a
  Files place you control, and self-improving skills the assistant curates in the background.
- **Scheduled tasks** that run on their own and notify you.
- **Your choice of model** — ChatGPT, Claude, OpenRouter, Ollama or LM Studio — with per-turn
  control over reasoning effort and speed.
- **macOS and Linux** builds.
