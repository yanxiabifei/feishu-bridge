const test = require('node:test');
const assert = require('node:assert');
const { summarizeToolUse } = require('../src/agent/tools');

const line = (o) => JSON.stringify(o);
const toolUse = (name, input = {}) => ({ type: 'tool_use', name, input });
const toolResult = (id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' });
const assistant = (...blocks) => line({ type: 'assistant', message: { content: blocks } });
const results = (...ids) => line({ type: 'user', message: { content: ids.map(toolResult) } });

test('统计工具次数与改动文件数（真实 tool_result 交替）', () => {
  const jsonl = [
    line({ type: 'system', subtype: 'init' }),
    line({ type: 'user', message: { content: '改地形' } }),
    assistant(toolUse('Edit', { file_path: 'a.gd' })),
    results('t1'),
    assistant(
      toolUse('Edit', { file_path: 'a.gd' }),
      toolUse('Bash', { command: 'ls' }),
    ),
    results('t2', 't3'),
    line({ type: 'system', subtype: 'mode' }),
    line({ type: 'last-prompt', message: {} }),
  ].join('\n');
  assert.strictEqual(summarizeToolUse(jsonl), '🔧 改了 1 个文件 · Edit×2 · Bash×1');
});

test('遇到真实用户提示（字符串 content）才停，tool_result 继续往前扫', () => {
  const jsonl = [
    assistant(toolUse('Read', {})),
    line({ type: 'user', message: { content: '第二轮' } }),
    assistant(toolUse('Bash', { command: 'ls' })),
    results('t1'),
  ].join('\n');
  assert.strictEqual(summarizeToolUse(jsonl), '🔧 Bash×1');
});

test('isMeta 技能注入与数组内 text 块都算真实用户边界', () => {
  const jsonl = [
    assistant(toolUse('Bash', { command: 'ls' })),
    line({
      type: 'user',
      isMeta: true,
      message: { content: [{ type: 'text', text: '技能注入' }] },
    }),
    assistant(toolUse('Grep', {})),
    results('t1'),
  ].join('\n');
  assert.strictEqual(summarizeToolUse(jsonl), '🔧 Grep×1');
});

test('尾部 tool_result 不会让摘要变空', () => {
  const jsonl = [
    line({ type: 'user', message: { content: '改地形' } }),
    assistant(toolUse('Edit', { file_path: 'b.gd' })),
    results('t1'),
  ].join('\n');
  assert.strictEqual(summarizeToolUse(jsonl), '🔧 改了 1 个文件 · Edit×1');
});

test('没有工具调用返回空串', () => {
  const jsonl = [
    line({ type: 'assistant', message: { content: [{ type: 'text', text: '直接回答' }] } }),
    results('t1'),
  ].join('\n');
  assert.strictEqual(summarizeToolUse(jsonl), '');
});

test('坏行与空行跳过', () => {
  const jsonl = [
    '',
    '不是 json',
    assistant(toolUse('Grep', {})),
  ].join('\n');
  assert.strictEqual(summarizeToolUse(jsonl), '🔧 Grep×1');
});
