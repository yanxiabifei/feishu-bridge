const test = require('node:test');
const assert = require('node:assert');
const { summarizeToolUse } = require('../src/agent/tools');

const line = (o) => JSON.stringify(o);

test('统计工具次数与改动文件数', () => {
  const jsonl = [
    line({ type: 'user', message: { content: '改地形' } }),
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: 'a.gd' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'a.gd' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }),
  ].join('\n');
  assert.strictEqual(summarizeToolUse(jsonl), '🔧 改了 1 个文件 · Edit×2 · Bash×1');
});

test('只看最后一轮：从后往前扫，遇到 user 消息就停', () => {
  const jsonl = [
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } }),
    line({ type: 'user', message: { content: '第二轮' } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
  ].join('\n');
  assert.strictEqual(summarizeToolUse(jsonl), '🔧 Bash×1');
});

test('没有工具调用返回空串', () => {
  const jsonl = line({ type: 'assistant', message: { content: [{ type: 'text', text: '直接回答' }] } });
  assert.strictEqual(summarizeToolUse(jsonl), '');
});

test('坏行与空行跳过', () => {
  const jsonl = [
    '',
    '不是 json',
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: {} }] } }),
  ].join('\n');
  assert.strictEqual(summarizeToolUse(jsonl), '🔧 Grep×1');
});
