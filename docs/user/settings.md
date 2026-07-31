# Settings

← [Stem guide](../README.md)

Maya uses ChatGPT for everyday consulting, adds a local Ollama model for sensitive
drafts, keeps command approval on **Assisted**, and gives Quick Chat short-answer
instructions.

<!-- TODO(screenshot): Recapture with the canonical Maya demo profile. -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../screenshots/settings-providers-dark.png">
    <img alt="Stem Settings with the model picker and AI providers" src="../screenshots/settings-providers-light.png" width="320">
  </picture>
</p>

## Providers and models

Add a provider with:

- **Account**: ChatGPT, Claude, or Grok sign-in. Grok signs in with a code you
  confirm in the browser (SuperGrok or X Premium).
- **API key**: Anthropic, OpenAI, OpenRouter, or xAI.
- **Local server**: Ollama or LM Studio. Stem hides Ollama models without tool
  support; they cannot complete Stem turns.

The selected model receives the prompt, attachments, and context Stem adds to that
turn. A cloud model receives that data on its provider’s service. A local model
sends it to the server address you configured.

**Native web search** appears only for compatible models. It sends the search to
that model’s provider and returns cited sources.

## Command approvals

Turn **Run commands** off to disable shell commands. With **Assisted**, the selected
safety-check model receives the command and working folder. A cloud model processes
that text on its provider.

- **Manual**: known-safe and always-allowed commands run; everything else asks first.
- **Assisted**: an AI safety check passes routine commands and asks about uncertain
  ones. A convenience, not a security boundary.
- **Yolo**: commands run without asking. Read-only connected folders remain
  protected.

On an approval card, **Always allow** saves a command prefix for future turns.
Keep prefixes narrow; `git status` grants less access than `git`.

<!-- TODO(screenshot): Command approval card with Allow once, Always allow, and Deny. -->

## Escape key

- **Off** — does nothing while Stem is working.
- **Single** — stops the turn and retracts the sent message.
- **Two-stage** — first press stops; second press retracts.

## Context used across chats

- **Files folder**: files Stem may read from any chat. They are not automatically
  attached to every prompt.
- **Standing instructions**: directions applied to the main app and Quick Chat.
- [**Memory**](memory/README.md) and
  [**Connected folders**](connected-folders.md) have their own controls. Their
  enabled, relevant content may be added to a turn.

When Stem proposes changing standing instructions, review the approval card before
accepting.

## Quick Chat defaults

Set a separate model, effort, speed, web-search choice, shortcut, finish sound,
idle reset, and extra instructions. Extra [Quick Chat](quick-chat.md) instructions
are added on top of the standing instructions.

**Show on all displays** lets the overlay follow Spaces and displays. **Show progress
on other Spaces** can also show progress for the main Stem window.

On Linux with Wayland, set the command shown in Settings as a desktop keyboard
shortcut; the recorded global shortcut cannot fire there.
