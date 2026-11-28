# feishu-bridge

**手机飞书群和电脑上的 Claude Code / Codex，是同一个会话、同一块终端屏幕** —— 不是两个 AI 互相转述。

[English](README.en.md) · [MIT](LICENSE) · [参与贡献](CONTRIBUTING.md) · Windows 10/11 · Node.js ≥ 22

[![test](https://github.com/yanxiabifei/feishu-bridge/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/yanxiabifei/feishu-bridge/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 不用公网 IP，不用内网穿透，不走任何境外服务器 —— 只靠飞书开放平台的长连接。

## 它是什么

电脑上真的开着一个终端。守护进程攥着 PTY，手机看到的就是这台终端进程的真实输出；群里说一句话，它就在那个会话里干活，答完把结果发回群里。

## 能干什么

- **手机拉群开工**：新建群、拉机器人，`@机器人 <别名> <任务>`，电脑起新会话
- **同一块屏幕**：卡片里的「当前画面」截的是终端画面本身，不是摘要
- **多项目并行**：一个项目一个群，互不串话
- **电脑端镜像窗口**：本机开一个 Electron 窗口，看到和手机同一块终端；关窗只是收进托盘，手机新拉群时 3 秒内自动弹出来，可选开机自启
- **私聊总控**：发「列表」看所有会话，发「状态」看守护进程和长连接健不健康，「结束 <别名>」关掉，「改名 <旧> <新>」改别名
- **回复卡片原地更新**：先出「处理中」，答完在同一张卡片上更新，不刷屏

## 凭什么用它

多数桥接只把对话转成飞书卡片：你看得到字，看不到终端屏幕。这个项目让守护进程攥着 PTY，手机看到的就是电脑上那个终端进程发出来的字节流——不是转述，也不是摘要。

> 注：不接管你从控制台已经开着的 `claude`，只管自己新开的会话。电脑端镜像窗口已经可用，见「怎么用」第 4 步。
>
> 守护进程是单例，重复启动自己退出；App Secret 用 Windows DPAPI 加密存放。

## 这东西适合我吗

**适合**：电脑上常驻 Claude Code / Codex，人经常不在电脑前，但想随时派活、看结果。

**不适合**：用 macOS / Linux（未验证），或者不能接受「手机发一句话，电脑就执行命令」。

## 怎么用

直接扔给 AI 🤣～

需要 Node.js ≥ 22。

1. 在[飞书开放平台](https://open.feishu.cn/app)建一个**企业自建应用**，开启机器人能力，配好：

   | 类型 | 内容 |
   |---|---|
   | 权限 | `im:message`、`im:message:send_as_bot`、`im:chat`、`im:chat:delete`、`cardkit:card` |
   | 事件 | `im.message.receive_v1`（连接方式选**长连接**） |

   然后发版，确认自己在该应用的可用范围内。

2. 安装、初始化、启动：

   ```bash
   npm install
   npm run setup   # 填 App ID / App Secret，顺带自检
   npm start       # 常驻守护进程
   ```

3. 私聊机器人发「列表」；建个群把机器人拉进去，`@机器人 要做什么` 就能开工。

4. 想在电脑上也看着同一块屏（可选）：

   ```bash
   npm run window   # 开发模式，直接起窗口
   npm run pack     # 或者打成免安装的 dist/feishu-bridge-win32-x64/feishu-bridge.exe
   ```

   窗口关掉只是收进托盘，托盘右键有「打开选择器 / 开机启动 / 退出」。手机新拉群、`@机器人` 发第一句时，窗口会自动弹出来。**开机自启和「窗口不在线也能被拉起来」只在这个打包版里完整生效** —— 开发模式不写注册表，勾选框是灰的。

## ⚠️ 用之前必须知道

- **全自动权限**：Claude 跑在 `--permission-mode bypassPermissions`，Codex 跑在 `--dangerously-bypass-approvals-and-sandbox`。**能让机器人看到消息的人，就能在你电脑上执行命令。** 只拉自己的群，别分享 App Secret。
- **电脑必须开着**，手机唤醒不了关机的机器。
- 一个群绑定一个会话、一个目录；中途换目录等于开新会话。
- 不能接管你已经在 Windows Terminal 里跑着的 claude 会话 —— 两条路并行，互不干扰。

## 它长什么样

<!-- 待补：手机端截图 —— 群里 @机器人 → 回复卡片、私聊「状态」「列表」。
     拍摄与脱敏要求见 docs/screenshots-guide.md，拍好放 docs/images/ 后在这里引用。 -->

## 深入

工程细节都在 `docs/`，不需要为了用它而读：

- [`docs/faq.md`](docs/faq.md) —— 常见问题：配置失败、没反应、日志在哪
- [`docs/architecture.md`](docs/architecture.md) —— 进程模型、ConPTY 与屏幕状态机、配置项、目录结构、开发与测试
- [`docs/acceptance.md`](docs/acceptance.md) —— 验收清单
- [`docs/superpowers/specs/`](docs/superpowers/specs/) · [`docs/superpowers/plans/`](docs/superpowers/plans/) —— 设计规格与实现计划

## 参与贡献

- 用不起来？先看 [`docs/faq.md`](docs/faq.md)；确实是 bug 就按模板开 issue。
- 想改代码？读 [CONTRIBUTING.md](CONTRIBUTING.md)，本地 `npm test` 全绿再开 PR。一个 PR 做一件事。
- 安全问题不要公开提，按 [SECURITY.md](SECURITY.md) 私密报告。
- 有真机截图或录屏？按 [`docs/screenshots-guide.md`](docs/screenshots-guide.md) 拍 —— 比任何文案都直观。
- 接下来可能做什么，写在 [ROADMAP.md](ROADMAP.md)。

## 许可

MIT
