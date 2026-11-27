# 参与贡献

谢谢你看这个项目。它现在是一个人维护的，任何形式的帮助都有用——包括提 bug、写文档、回答问题。

## 什么样的贡献受欢迎

- **Bug 报告**：附上复现步骤和日志片段（脱敏后）。
- **使用场景**：你拿它做了什么、哪里别扭。很多设计是被真实场景推着改的。
- **文档**：README 里哪句话没看懂、哪一步卡住了，直接改，PR 不需要很大。
- **代码**：修 bug、补测试、加功能。**开 PR 之前先开 issue 说一下**，避免写完发现方向不对。

不欢迎：单纯改格式的大 diff、引入新依赖但不说明为什么、削弱安全边界的改动（见下）。

## 三条底线

1. **安全边界不能悄悄削弱。** 项目故意用 `--permission-mode bypassPermissions` 和 `--dangerously-bypass-approvals-and-sandbox` 启动 agent，这是产品设计。任何让 IPC 暴露到回环地址之外、让凭据明文落盘、让日志更容易泄漏 token 的改动都不会被合并。
2. **只支持 Windows。** 依赖 ConPTY、DPAPI 和 PowerShell；macOS / Linux 的适配是独立话题，先开 issue 讨论。
3. **测试必须绿。** 不接受"先合了再补测试"。

## 开发环境

- Windows 10/11
- Node.js **22 或 24**（测试脚本用了 `--test` 的 glob，Node 20 跑不了）
- 一份本机能跑的 `claude`（跑真实会话时用；单元测试不需要）

```bash
git clone https://github.com/yanxiabifei/feishu-bridge.git
cd feishu-bridge
npm ci
npm test          # 单元测试，离线，约 10 秒
npm run test:e2e  # 离线端到端，用假 agent，不需要真 claude
```

跑真实会话才需要走 `npm run setup`（会写 `state/`，已被 `.gitignore` 排除）。

## 改代码的约定

- **先写测试。** 这个项目里最脆的是 `src/screen.js`（从终端画面判断输入框是否就绪），动它之前先看 `test/screen.test.js` 和 `test/screen-real.test.js`。
- **依赖要克制。** 目前只有 4 个生产依赖。加新依赖请在 PR 里说清楚为什么现有代码做不到。
- **注释写"为什么"，不写"是什么"。** 现有代码就是这个风格。
- **别顺手重构。** 一个 PR 只做一件事，格式改动单独开。

## 提交信息

用 Conventional Commits，type 用英文，描述中英文都行：

```
fix(screen): 括号粘贴后误判输入框未就绪
feat(session): 支持一个群绑定多个目录
docs: 补充飞书应用权限截图说明
```

常用 type：`feat` `fix` `docs` `test` `refactor` `chore`。破坏性改动在正文里写 `BREAKING CHANGE:`。

## 提交 PR

1. Fork → 从 `main` 拉分支（`fix/xxx`、`feat/xxx`）。
2. 本地跑 `npm test` 和 `npm run test:e2e`，确认都过。
3. 开 PR，按模板填：解决什么、怎么验证的。
4. CI 会在 Windows × Node 22/24 上跑一遍，绿了才会看。

维护者回复可能不快，但不会忽略。

## 报告安全问题

**不要开公开 issue。** 见 [SECURITY.md](SECURITY.md)。

## 行为准则

参与即表示同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
