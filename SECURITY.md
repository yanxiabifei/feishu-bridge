# 安全策略

## 先读这一段：这个项目**故意**允许远程执行命令

feishu-bridge 的设计目标就是"手机发一句话，电脑执行命令"。因此：

- Claude 以 `--permission-mode bypassPermissions` 启动，Codex 以 `--dangerously-bypass-approvals-and-sandbox` 启动；
- **能给机器人发消息的人，就能在这台电脑上执行任意命令。**

这不是漏洞，是产品前提。部署时只能把机器人拉进自己的群，App Secret 不能给任何人。

## 什么算安全漏洞

- 不在群里、没有权限的人，能让机器人执行命令；
- IPC（`127.0.0.1:47831`）能被本机其他用户或其他进程无鉴权调用；
- App Secret、token 以明文落盘，或出现在日志、卡片、错误信息里；
- `npm run check:logs` 扫不出来的凭据泄漏路径；
- 依赖供应链问题（请附 `npm audit` 输出）；
- 飞书消息内容能够突破当前目录、越权读写本机文件（在已授权的目录范围之外）。

## 什么不算漏洞

- "它能执行命令"——见上一节；
- 需要先拿到本机 Windows 账户权限才能利用的问题；
- 社会工程（例如骗你把机器人拉进群）。

## 怎么报告

**不要开公开 issue，不要在群里贴日志或 App Secret。**

用 GitHub 的私密报告通道：

1. 打开 https://github.com/yanxiabifei/feishu-bridge/security/advisories/new
2. 写清楚：影响版本、复现步骤、影响范围、你建议的修复方向（如果有）。

如果这个入口用不了，通过 GitHub 账号 [@yanxiabifei](https://github.com/yanxiabifei) 联系维护者。

## 支持范围

只维护最新的 0.x 版本。0.x 期间不承诺固定的响应时限，但会尽快确认收到并给出处理计划。

## 报告前请先脱敏

日志里可能出现 App ID、目录名、命令内容。贴之前先跑一遍：

```bash
npm run check:logs
```

它用本机保存的 App Secret 和当前环境里的 `ANTHROPIC_AUTH_TOKEN` 做精确匹配，扫描 `logs/` 下的日志；读不到凭据或没有配置凭据时会报错/跳过（不算通过）。通过之后仍然请人工再看一眼。
