# feishu-bridge

**One session, one terminal screen — shared between a Feishu/Lark group on your phone and Claude Code / Codex on your PC.** Not two AIs talking to each other.

[中文文档](README.md) · [MIT](LICENSE) · [Contributing](CONTRIBUTING.md) · Windows 10/11 · Node.js ≥ 22

[![test](https://github.com/yanxiabifei/feishu-bridge/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/yanxiabifei/feishu-bridge/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> No public IP, no tunneling, no third-party relay — it rides Feishu's long-connection API.

## What it is

A real terminal runs on your PC. The daemon owns the PTY, so your phone sees the actual output of that process; send a message in the group and it works inside that same session, then posts the result back.

## What you can do

- **Start from your phone**: create a group, add the bot, `@bot <alias> <task>`, and a new session starts on the PC.
- **See the same screen**: the “current screen” card is the terminal itself, not a summary.
- **Run projects in parallel**: one group per project, no cross-talk.
- **Desktop mirror window**: an Electron window on the PC shows the same terminal; closing it just hides it to the tray, and a new group from your phone pops it up within ~3 seconds. Optional autostart.
- **DM control panel**: `列表` to list sessions, `结束 <alias>` to close, `改名 <old> <new>` to rename.
- **In-place reply cards**: “working” first, updated with the answer on the same card.

## Why this one

Most bridges turn the conversation into Feishu cards: you see words, not the terminal. Here the daemon owns the PTY, so the phone receives the actual byte stream from the terminal process — no relaying, no summarising.

> It does **not** attach to a `claude` you already started in a console; it only manages sessions it started. The desktop mirror window ships with the app — see step 4 under “How to use”.
>
> Single-instance daemon; App Secret encrypted with Windows DPAPI.

## Is this for you?

**Yes** if you keep Claude Code / Codex running on a Windows box and want to hand it tasks while away from the keyboard.

**No** if you use macOS/Linux (untested), or are uncomfortable with "one chat message → arbitrary command execution on my machine".

## How to use

Just hand it to an AI 🤣～

1. Create an **enterprise self-built app** on the [Feishu Open Platform](https://open.feishu.cn/app), enable the bot, and grant:

   | Type | Value |
   |---|---|
   | Scopes | `im:message`, `im:message:send_as_bot`, `im:chat`, `im:chat:delete`, `cardkit:card` |
   | Events | `im.message.receive_v1` (connection mode: **long connection**) |

   Publish a version and make sure you are in the app's availability scope.

2. Install and run:

   ```bash
   npm install
   npm run setup   # prompts for App ID / App Secret, then self-checks
   npm start       # single-instance daemon
   ```

3. DM the bot `列表` (list) to see sessions. Add the bot to a group, then `@bot <alias> <task>`.

4. Want the same screen on the PC as well (optional):

   ```bash
   npm run window   # dev mode: start the window directly
   npm run pack     # or build a portable dist/feishu-bridge-win32-x64/feishu-bridge.exe
   ```

   Closing a window only hides it to the tray; the tray menu has “open picker / autostart / quit”. A new group from your phone makes the window pop up automatically. **Autostart and “the daemon can launch the window when it is offline” only fully work in the packaged build** — dev mode never touches the registry and the autostart checkbox is greyed out.

## Read before use

- **Fully automatic permissions.** Claude runs with `--permission-mode bypassPermissions`, Codex with `--dangerously-bypass-approvals-and-sandbox`. **Anyone who can message the bot can run commands on your machine.** Only add it to your own groups; never share the App Secret.
- Your PC must stay on.
- One group ↔ one session ↔ one directory.

## Docs

Engineering details live in [`docs/`](docs/) (Chinese):

- [`docs/faq.md`](docs/faq.md) — common failures, no response, where the logs are (Chinese)
- [`docs/architecture.md`](docs/architecture.md) — process model, ConPTY + screen state machine, config, layout, tests
- [`docs/acceptance.md`](docs/acceptance.md) — acceptance checklist

## Contributing

- Stuck? Read [`docs/faq.md`](docs/faq.md) first, then open an issue using the template.
- Code changes: read [CONTRIBUTING.md](CONTRIBUTING.md), make sure `npm test` passes locally, one PR per thing.
- Security issues: report privately, see [SECURITY.md](SECURITY.md).
- What's planned: [ROADMAP.md](ROADMAP.md).

## License

MIT
