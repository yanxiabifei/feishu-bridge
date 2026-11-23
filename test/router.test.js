const test = require('node:test');
const assert = require('node:assert');
const { parseFirstMessage } = require('../src/session/router');

const base = { defaultCwd: 'D:/feishu-workspace', exists: () => false };

test('别名命中，剩余部分作为 prompt', () => {
  const r = parseFirstMessage('卡牌 帮我加个技能', {
    ...base,
    aliases: { 卡牌: 'D:/★CardGame/demo44' },
  });
  assert.deepStrictEqual(r, {
    cwd: 'D:/★CardGame/demo44',
    alias: '卡牌',
    prompt: '帮我加个技能',
    source: 'alias',
  });
});

test('只发别名，prompt 为空串', () => {
  const r = parseFirstMessage('卡牌', { ...base, aliases: { 卡牌: 'D:/★CardGame/demo44' } });
  assert.strictEqual(r.prompt, '');
  assert.strictEqual(r.source, 'alias');
});

test('别名后跟中文（无分隔）不命中，退回默认目录', () => {
  const r = parseFirstMessage('卡牌游戏 加个技能', {
    ...base,
    aliases: { 卡: 'D:/a', 卡牌: 'D:/b' },
  });
  assert.strictEqual(r.source, 'default');
  assert.strictEqual(r.cwd, 'D:/feishu-workspace');
  assert.strictEqual(r.prompt, '卡牌游戏 加个技能');
});

test('全角冒号也能分隔别名与正文', () => {
  const r = parseFirstMessage('卡牌：加个技能', { ...base, aliases: { 卡牌: 'D:/b' } });
  assert.strictEqual(r.prompt, '加个技能');
});

test('盘符路径存在时用它，剩余句子作为 prompt', () => {
  const r = parseFirstMessage('D:/work/alpha 跑一下测试', {
    ...base,
    exists: (p) => p === 'D:/work/alpha',
  });
  assert.deepStrictEqual(r, {
    cwd: 'D:/work/alpha',
    alias: null,
    prompt: '跑一下测试',
    source: 'path',
  });
});

test('盘符路径不存在时明确报告，不静默退回默认目录', () => {
  const r = parseFirstMessage('D:/nope/alpha 跑一下测试', base);
  assert.strictEqual(r.source, 'path-missing');
  assert.strictEqual(r.cwd, null);
  assert.strictEqual(r.prompt, 'D:/nope/alpha 跑一下测试');
});

test('反斜杠路径同样识别', () => {
  const r = parseFirstMessage('D:\\work\\alpha 跑测试', {
    ...base,
    exists: (p) => p === 'D:\\work\\alpha',
  });
  assert.strictEqual(r.source, 'path');
  assert.strictEqual(r.prompt, '跑测试');
});

test('前导空白与 @ 提及残留不影响解析', () => {
  const r = parseFirstMessage('   卡牌  加个技能  ', { ...base, aliases: { 卡牌: 'D:/b' } });
  assert.strictEqual(r.prompt, '加个技能');
});
