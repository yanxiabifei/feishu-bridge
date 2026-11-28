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
    agent: null,
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
    agent: null,
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

test('「用 codex」→ agent=codex，并从 prompt 里去掉这一段', () => {
  const r = parseFirstMessage('卡牌 用 codex 写个快排', {
    ...base,
    aliases: { 卡牌: 'D:/b' },
  });
  assert.strictEqual(r.agent, 'codex');
  assert.strictEqual(r.prompt, '写个快排');
  assert.strictEqual(r.cwd, 'D:/b');
});

test('开头直接说 codex 也能识别（带全角冒号）', () => {
  const r = parseFirstMessage('codex：写个快排', base);
  assert.strictEqual(r.agent, 'codex');
  assert.strictEqual(r.prompt, '写个快排');
});

test('正文里只是提到 codex 时不改 agent', () => {
  const r = parseFirstMessage('看看 codex 的配置文件在哪', base);
  assert.strictEqual(r.agent, null);
  assert.strictEqual(r.prompt, '看看 codex 的配置文件在哪');
});

test('句中顺口说「用 codex」不算指定，agent 保持 null', () => {
  const r = parseFirstMessage('这个功能用 codex 实现过', base);
  assert.strictEqual(r.agent, null);
  assert.strictEqual(r.prompt, '这个功能用 codex 实现过');
});

test('codex 后面紧跟英文/数字/连字符不算指定（codexwriter、codex-cli）', () => {
  for (const msg of ['codexwriter 是什么', 'codex-cli 怎么装']) {
    const r = parseFirstMessage(msg, base);
    assert.strictEqual(r.agent, null);
    assert.strictEqual(r.prompt, msg);
  }
});

test('剥掉「用 codex」后保留 prompt 的换行与原有空白', () => {
  const r = parseFirstMessage('用 codex 写个快排\n\n要求：用递归', base);
  assert.strictEqual(r.agent, 'codex');
  assert.strictEqual(r.prompt, '写个快排\n\n要求：用递归');
});

test('句首 codex 后面跟中文/标点仍能识别', () => {
  const r = parseFirstMessage('codex，写个快排', base);
  assert.strictEqual(r.agent, 'codex');
  assert.strictEqual(r.prompt, '，写个快排');
});

test('7 个字的别名也能命中：改名上限放宽后路由要跟得上', () => {
  const alias = '飞书桥接项目组';
  const r = parseFirstMessage(`${alias} 改个文档`, {
    ...base,
    aliases: { [alias]: 'D:/feishu-bridge' },
  });
  assert.strictEqual(r.source, 'alias');
  assert.strictEqual(r.cwd, 'D:/feishu-bridge');
  assert.strictEqual(r.prompt, '改个文档');
});

test('20 个字的别名（上限）也能命中', () => {
  const alias = '一二三四五六七八九十一二三四五六七八九十';
  assert.strictEqual(Array.from(alias).length, 20);
  const r = parseFirstMessage(`${alias} 开工`, {
    ...base,
    aliases: { [alias]: 'D:/x' },
  });
  assert.strictEqual(r.source, 'alias');
  assert.strictEqual(r.prompt, '开工');
});
