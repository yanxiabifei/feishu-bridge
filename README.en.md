# feishu-bridge

**A two-way bridge between a Feishu/Lark chat on your phone and Claude Code / Codex running on your PC.**

Send a message in a Feishu group from your phone; a real terminal session starts on your computer, does the work, and posts the answer back to the group.

No public IP, no tunneling, no third-party relay — it rides Feishu's long-connection API.

[中文文档](README.md) · [MIT](LICENSE) · Windows 10/11 · Node.js ≥ 20

[![test](https://github.com/yanxiabifei/feishu-bridge/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/yanxiabifei/feishu-bridge/actions/workflows/test.yml)

## Is this for you?

**Yes** if you keep Claude Code / Codex running on a Windows box and want to hand it tasks while away from the keyboard.

**No** if you want a desktop mirror window (not implemented), use macOS/Linux (untested), or are uncomfortable with "one chat message → arbitrary command execution on my machine".

## Quick start

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

## Read before use

- **Fully automatic permissions.** Claude runs with `--permission-mode bypassPermissions`, Codex with `--dangerously-bypass-approvals-and-sandbox`. **Anyone who can message the bot can run commands on your machine.** Only add it to your own groups; never share the App Secret.
- Your PC must stay on.
- One group ↔ one session ↔ one directory.

## Docs

Engineering details live in [`docs/`](docs/) (Chinese):

- [`docs/architecture.md`](docs/architecture.md) — process model, ConPTY + screen state machine, config, layout, tests
- [`docs/acceptance.md`](docs/acceptance.md) — acceptance checklist

## License

MIT
