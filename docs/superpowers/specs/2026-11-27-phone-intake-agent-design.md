# 手机建群「无头接待」设计规格

- 日期：2026-11-27
- 状态：已实现（2026-11-27）
- 范围：`createFromPhone` 建会话前的决策环节

---

## 0. 一句话

手机新群第一句话进来时，先跑一个**一次性的无头 Claude Code**，让它读懂这句话：确定在哪个目录开工、群名叫什么、交给持久会话的第一句指令怎么写。它不做任何实际工作，5–9 秒后消失，结论接回现有建会话流程。

---

## 1. 目标与非目标

### 目标

| # | 要求 |
|---|---|
| I1 | 新群第一句话 → 无头接待给出 `{cwd, groupName, prompt, note}` |
| I2 | 用户原话和接待的结论一起转交给持久会话，作为它的开头上下文 |
| I3 | 任何异常（超时、格式错、目录不存在）回退到现有规则流程，**绝不阻断建会话** |
| I4 | 确定性结果（别名前缀 / 盘符路径）不被模型推翻 |
| I5 | 群名沿用已落地的 `renameGroupOnce`，只改一次 |

### 明确不做

- 不做工具调用：`--tools ""`，只看句子，不读目录、不建目录、不干活。
- 不接管鼠标键盘、不弹审批、不新增任何审批步骤。
- 不改 `createFromPc`（电脑建群命名规则 `${label} · ${stamp}` 保持不变）。

---

## 2. 流程

```
群第一条消息
   │
   ├─ parseFirstMessage（现有规则）
   │     结果 path-missing → 现有「目录不存在」错误卡，结束（不调无头）
   │
   ├─ 调无头接待（20s 超时）
   │     成功 → 用它的 groupName / prompt / note
   │     失败 → 全部沿用规则结果，只记 warn
   │
   ├─ 校验：cwd 必须存在（否则回退规则结果）；groupName 去换行、截断 20 字
   │
   ├─ createFromPhone 建 record + spawn（目录、别名、群名用校验后的值）
   ├─ 首条入队 = 交接块 + 接待整理后的指令
   ├─ 「已开工」卡片（带 note）
   └─ renameGroupOnce（群名 = 接待结论）
```

### 2.1 无头调用（已实测）

```
claude -p "<prompt>" --output-format json --tools "" \
       --exclude-dynamic-system-prompt-sections --max-turns 2 \
       --no-session-persistence --json-schema <schema>
```

- 可执行文件取 `config.claudeExe`。
- `--no-session-persistence`：不落 transcript，进程退出即彻底消失，事后无法被
  `--resume` 接回——这是用户明确要求的一次性语义。
- 实测：5–9 秒，约 6.5k 输入 token，返回 `structured_output`（schema 保证格式）。
- 子进程环境沿用 `childEnv()` 的剔除表（去掉 `CLAUDECODE` 等宿主标记），否则会出现
  「Transcript saving is off」这类页脚干扰。
- 超时用 `execFile` 的 `timeout`，超时即 kill，视为失败。

### 2.2 输入内容

只放这些，不放密钥、不放整份文件：

```
用户第一句话：<原句>
当前时间：<YYYY-MM-DD HH:mm>
候选目录（别名=路径）：
  卡牌=D:\★CardGame\demo44
  ...
默认目录：<config.defaultCwd>
[规则已确定目录为 X，不得更改]   ← 仅当规则命中 alias/path 时出现
```

### 2.3 输出 schema

```json
{
  "type": "object",
  "properties": {
    "cwd":       { "type": "string" },
    "groupName": { "type": "string" },
    "prompt":    { "type": "string" },
    "note":      { "type": "string" }
  },
  "required": ["cwd", "groupName", "prompt"],
  "additionalProperties": false
}
```

- `cwd`：开工目录，必须已存在；规则已确定时忽略它的值。
- `groupName`：群名，去换行、trim、最长 20 字；空则回退别名/目录名。
- `prompt`：交给持久会话的指令，保留用户意图，可补足必要的上下文；不得凭空加
  需求。
- `note`：一句话解释判断（为什么选这个目录/名字），进「已开工」卡片；可为空。

---

## 3. 交接给持久会话

首条提交的文本（用户要求把上下文一起转接）：

```
（前台接待备忘：用户原话「<原句>」；工作目录 <cwd>。<note>）

<prompt>
```

- 只有两行摘要，不塞完整对话。
- 仅当接待自己写了 `prompt` 时才拼这个备忘块；它没给指令时沿用规则指令，不硬塞摘要。
- 「已开工」卡片同样展示摘要，用户能在手机上一眼看到接待判断。

---

## 4. 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `intakeEnabled` | `true` | 关掉则完全走旧规则流程 |
| `intakeTimeoutMs` | `20000` | 超过即 kill 并回退 |

写进 `src/config.js` 的 `DEFAULTS`；已有 `state/config.json` 不写这两个键也照常工作。

---

## 5. 文件与职责

| 文件 | 职责 |
|---|---|
| 新建 `src/session/intake.js` | 组装 prompt、调用无头、解析与校验、回退规则 |
| 修改 `src/session/manager.js` | `createFromPhone` 改调 intake；交接块入队；群名取自 intake |
| 修改 `src/config.js` | 新增两个默认键 |
| 新建 `test/intake.test.js` | 纯函数级测试（注入 fake runner） |
| 修改 `test/manager.test.js` | 建会话集成测试 |

`intake.decide({ text, projects, defaultCwd, exists, now, runIntake })` 全部依赖注入，
测试不启动真实 CLI。

---

## 6. 测试清单

1. 规则命中别名 + runner 返回群名/指令 → cwd 用规则值，群名用 runner 值，首条含原话与 note。
2. runner 抛错 / 超时 → 回退规则结果，首条 = 原句（无备忘块也行），建会话成功。
3. runner 返回不存在的 cwd → 回退规则 cwd。
4. groupName 超 20 字 → 截断；空串 → 用别名/目录名。
5. runner 返回坏 JSON → 回退，不抛。
6. `intakeEnabled: false` → 不调用 runner。
7. `createFromPhone` 集成：群名走 `renameChat`，记录 `groupRenamed`；「已开工」卡片含 note。
8. 规则 `path-missing` → 仍发「目录不存在」错误卡，不调用 runner。

---

## 7. 成本与护栏

- 每个新群一次，约 6.5k 输入 token；不随消息数增长。
- 20 秒超时、`--max-turns 2`、无工具——跑飞不了。
- 目录只接受「已存在」，不接受新建；找不到就落默认目录并在 note 里说明。
