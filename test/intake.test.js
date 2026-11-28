const test = require('node:test');
const assert = require('node:assert');
const { decide, parseCliOutput } = require('../src/session/intake');

const projects = { aliases: { 卡牌: 'D:/card', 其他: 'D:/other' }, default: 'D:/w' };
const exists = (p) => ['D:/card', 'D:/other', 'D:/w', 'D:/elsewhere'].includes(p);

function run(overrides = {}) {
  return decide({
    text: '卡牌 加个技能',
    projects,
    defaultCwd: 'D:/w',
    exists,
    runIntake: async () => ({
      cwd: 'D:/card', groupName: '卡牌技能', prompt: '给卡牌加一个技能', note: '按别名定位',
    }),
    ...overrides,
  });
}

test('别名命中：目录沿用规则结果，群名和指令用接待结论，首条带原话与备注', async () => {
  const r = await run({
    runIntake: async () => ({
      cwd: 'D:/elsewhere', groupName: '卡牌技能', prompt: '给卡牌加一个技能', note: '按别名定位',
    }),
  });
  assert.strictEqual(r.decidedBy, 'intake');
  assert.strictEqual(r.cwd, 'D:/card');
  assert.strictEqual(r.alias, '卡牌');
  assert.strictEqual(r.groupName, '卡牌技能');
  assert.ok(r.prompt.includes('用户原话「卡牌 加个技能」'));
  assert.ok(r.prompt.includes('工作目录 D:/card'));
  assert.ok(r.prompt.includes('按别名定位'));
  assert.ok(r.prompt.includes('给卡牌加一个技能'));
});

test('接待失败：回退规则结果，不抛错', async () => {
  const r = await run({ runIntake: async () => { throw new Error('超时'); } });
  assert.strictEqual(r.decidedBy, 'rule');
  assert.strictEqual(r.cwd, 'D:/card');
  assert.strictEqual(r.prompt, '加个技能');
  assert.strictEqual(r.groupName, null);
});

test('接待返回 null 或非对象：回退规则结果', async () => {
  for (const out of [null, 'x', 42]) {
    const r = await run({ runIntake: async () => out });
    assert.strictEqual(r.decidedBy, 'rule');
    assert.strictEqual(r.prompt, '加个技能');
  }
});

test('接待给的目录不在候选里：不采纳', async () => {
  const r = await run({
    text: '帮我修个 bug',
    runIntake: async () => ({
      cwd: 'D:/elsewhere', groupName: '修 bug', prompt: '修 bug', note: '',
    }),
  });
  assert.strictEqual(r.cwd, 'D:/w');
  assert.strictEqual(r.groupName, '修 bug');
});

test('接待给的目录在候选里且存在：采纳并带回别名', async () => {
  const r = await run({
    text: '帮我看看其他项目',
    runIntake: async () => ({
      cwd: 'D:/other', groupName: '其他项目', prompt: '看看其他项目', note: '',
    }),
  });
  assert.strictEqual(r.cwd, 'D:/other');
  assert.strictEqual(r.alias, '其他');
});

test('接待给的目录大小写/斜杠不同也按候选表归一，并存成配置里的写法', async () => {
  const r = await run({
    text: '帮我看看其他项目',
    runIntake: async () => ({
      cwd: 'd:\\Other', groupName: '其他项目', prompt: '看看其他项目', note: '',
    }),
  });
  assert.strictEqual(r.cwd, 'D:/other');
  assert.strictEqual(r.alias, '其他');
});

test('群名去换行、超长截断到 20 字、空串回退', async () => {
  const nl = await run({
    runIntake: async () => ({ groupName: '卡牌\n技能', prompt: '干活' }),
  });
  assert.strictEqual(nl.groupName, '卡牌 技能');

  const long = await run({
    runIntake: async () => ({ groupName: '一二三四五六七八九十一二三四五六七八九十多出来', prompt: '干活' }),
  });
  assert.strictEqual(long.groupName, '一二三四五六七八九十一二三四五六七八九十');

  const empty = await run({
    runIntake: async () => ({ groupName: '   ', prompt: '干活' }),
  });
  assert.strictEqual(empty.groupName, null);
});

test('接待没给指令时用规则指令', async () => {
  const r = await run({ runIntake: async () => ({ groupName: '卡牌', prompt: '' }) });
  assert.strictEqual(r.decidedBy, 'intake');
  assert.ok(r.prompt.includes('加个技能'));
  assert.ok(!r.prompt.includes('\n\n'));
});

test('enabled 为 false 时不调用接待', async () => {
  let called = 0;
  const r = await run({ enabled: false, runIntake: async () => { called += 1; } });
  assert.strictEqual(called, 0);
  assert.strictEqual(r.decidedBy, 'rule');
});

test('路径不存在时不调用接待', async () => {
  let called = 0;
  const r = await run({
    text: 'Q:\\nope 干活',
    runIntake: async () => { called += 1; },
  });
  assert.strictEqual(called, 0);
  assert.strictEqual(r.source, 'path-missing');
});

test('空文本（群里只发了一张图）不跑接待：没有要判断的内容，别白等一次模型', async () => {
  let called = 0;
  const r = await run({
    text: '',
    runIntake: async () => { called += 1; return { cwd: 'D:/card', groupName: 'x', prompt: 'x' }; },
  });
  assert.strictEqual(called, 0);
  assert.strictEqual(r.cwd, 'D:/w');
  assert.strictEqual(r.prompt, '');
  assert.strictEqual(r.decidedBy, 'rule');
});

test('parseCliOutput：优先读 structured_output，其次读 result 里的 JSON', () => {
  assert.deepStrictEqual(
    parseCliOutput('警告行\n{"structured_output":{"cwd":"D:/x"}}'),
    { cwd: 'D:/x' },
  );
  assert.deepStrictEqual(
    parseCliOutput('{"result":"{\\"cwd\\":\\"D:/y\\"}"}'),
    { cwd: 'D:/y' },
  );
  assert.strictEqual(parseCliOutput('完全不是 JSON'), null);
});
