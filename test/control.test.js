// test/control.test.js
const test = require('node:test');
const assert = require('node:assert');
const {
  parseControl, formatSessions, formatHealth, createControl,
} = require('../src/control');

function harness({ sessions = [], aliases = { 卡牌: 'D:/card' }, rename, getHealth } = {}) {
  const calls = [];
  const renames = [];
  const api = {
    sendText: async (chatId, text) => { calls.push(['text', chatId, text]); },
    sendCard: async (chatId, card) => { calls.push(['card', chatId, card]); },
  };
  const control = createControl({
    api,
    listSessions: () => sessions,
    closeSession: async (id, opts) => { calls.push(['close', id, opts]); },
    getProjects: () => ({ aliases, default: 'D:/w' }),
    renameAlias: (args) => { renames.push(args); return rename ? rename(args) : { ok: true }; },
    ownerOpenId: 'ou_me',
    getHealth,
  });
  return { control, calls, renames };
}

test('parseControl：列表 / 结束 / 改名 / 帮助 / 未知', () => {
  assert.deepStrictEqual(parseControl('列表'), { act: 'list' });
  assert.deepStrictEqual(parseControl('  面板 '), { act: 'list' });
  assert.deepStrictEqual(parseControl('结束 卡牌'), { act: 'end', target: '卡牌' });
  assert.deepStrictEqual(parseControl('关掉 D:/card'), { act: 'end', target: 'D:/card' });
  assert.deepStrictEqual(parseControl('改名 卡牌 卡牌2'), {
    act: 'rename', from: '卡牌', to: '卡牌2',
  });
  assert.deepStrictEqual(parseControl('帮助'), { act: 'help' });
  assert.deepStrictEqual(parseControl('随便说点啥'), { act: 'help' });
  assert.deepStrictEqual(parseControl(''), { act: 'help' });
});

test('parseControl：「状态」走健康检查，「列表」仍弹面板', () => {
  assert.deepStrictEqual(parseControl('状态'), { act: 'status' });
  assert.deepStrictEqual(parseControl(' 状态 '), { act: 'status' });
  assert.deepStrictEqual(parseControl('列表'), { act: 'list' });
  assert.deepStrictEqual(parseControl('会话'), { act: 'list' });
});

test('formatHealth：运行时长、长连接、IPC 和会话一览', () => {
  const now = Date.parse('2026-11-27T22:00:00+08:00');
  const startedAt = now - ((3 * 3600 + 25 * 60) * 1000);
  const text = formatHealth({
    startedAt,
    now,
    pid: 25984,
    ipcPort: 47831,
    ws: { state: 'connected', lastConnectTime: now - 60000 },
    sessions: [
      {
        id: 's1', alias: '卡牌', cwd: 'D:/card', agent: 'claude', status: 'running',
        lastActiveAt: new Date(now - 2 * 60000).toISOString(),
      },
      {
        id: 's2', alias: null, cwd: 'D:/w', agent: 'codex', status: 'idle',
        lastActiveAt: new Date(now - 3 * 3600000).toISOString(),
      },
    ],
  });
  assert.match(text, /运行 3 小时 25 分/);
  assert.match(text, /PID 25984/);
  assert.match(text, /已连接/);
  assert.match(text, /127\.0\.0\.1:47831/);
  assert.match(text, /会话：2 个/);
  assert.match(text, /1\. 卡牌（D:\/card） · Claude · 运行中 · 2 分钟前/);
  assert.match(text, /2\. D:\/w · Codex · 空闲 · 3 小时前/);
});

test('formatHealth：没有会话、长连接状态未知也能出结果', () => {
  const now = Date.parse('2026-11-27T22:00:00+08:00');
  const text = formatHealth({
    startedAt: now - 30000, now, sessions: [], ws: null,
  });
  assert.match(text, /不到 1 分钟/);
  assert.match(text, /未知/);
  assert.match(text, /会话：0 个/);
});

test('私聊「状态」：回健康文本，不弹面板卡片', async () => {
  const now = Date.now();
  const { control, calls } = harness({
    getHealth: () => ({
      startedAt: now - 5 * 60000,
      pid: 25984,
      ipcPort: 47831,
      ws: { state: 'connected' },
      sessions: [{ id: 's1', alias: '卡牌', cwd: 'D:/card', agent: 'claude', status: 'idle' }],
    }),
  });
  await control.onMessage({ chatId: 'oc_p2p', text: '状态', senderOpenId: 'ou_me' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], 'text');
  assert.match(calls[0][2], /桥接状态/);
  assert.match(calls[0][2], /运行 5 分钟/);
  assert.match(calls[0][2], /已连接/);
  assert.match(calls[0][2], /1\. 卡牌（D:\/card）/);
});

test('私聊「状态」：健康数据取不到时给出明确提示', async () => {
  const { control, calls } = harness();
  await control.onMessage({ chatId: 'oc_p2p', text: '状态', senderOpenId: 'ou_me' });
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0][2], /取不到/);
});

test('formatSessions：空列表与非空列表', () => {
  assert.match(formatSessions([]), /没有会话/);
  const text = formatSessions([
    { id: 's1', alias: '卡牌', cwd: 'D:/card', agent: 'claude', status: 'running' },
    { id: 's2', alias: null, cwd: 'D:/tmp', agent: 'codex', status: 'idle' },
  ]);
  assert.match(text, /1\. 卡牌（D:\/card） · Claude · 运行中/);
  assert.match(text, /2\. D:\/tmp · Codex · 空闲/);
});

test('非主人：私聊消息和卡片都静默忽略', async () => {
  const { control, calls } = harness();
  await control.onMessage({ chatId: 'oc_p2p', text: '列表', senderOpenId: 'ou_other' });
  await control.onCardAction({
    chatId: 'oc_p2p', openId: 'ou_other', action: { act: 'alias-rename', from: '卡牌' },
  });
  assert.deepStrictEqual(calls, []);
});

test('列表：发总控面板卡片，含会话状态和别名按钮', async () => {
  const { control, calls } = harness({
    sessions: [{ id: 's1', alias: '卡牌', cwd: 'D:/card', agent: 'claude', status: 'running' }],
  });
  await control.onMessage({ chatId: 'oc_p2p', text: '列表', senderOpenId: 'ou_me' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], 'card');
  const card = calls[0][2];
  const json = JSON.stringify(card);
  assert.ok(json.includes('卡牌'));
  assert.ok(json.includes('运行中'));
  const btn = card.body.elements.find((e) => e.tag === 'button');
  assert.deepStrictEqual(btn.behaviors[0].value, { act: 'alias-rename', from: '卡牌' });
});

test('结束：按别名或 id 找到会话并关闭，找不到就提示', async () => {
  const { control, calls } = harness({
    sessions: [
      { id: 's1', alias: '卡牌', cwd: 'D:/card', agent: 'claude', status: 'idle' },
      { id: 's2', alias: null, cwd: 'D:/x', agent: 'claude', status: 'idle' },
    ],
  });
  await control.onMessage({ chatId: 'oc_p2p', text: '结束 卡牌', senderOpenId: 'ou_me' });
  await control.onMessage({ chatId: 'oc_p2p', text: '结束 s2', senderOpenId: 'ou_me' });

  const closes = calls.filter((c) => c[0] === 'close');
  assert.deepStrictEqual(closes[0], ['close', 's1', { reason: '手机总控面板关闭', notify: true }]);
  assert.deepStrictEqual(closes[1], ['close', 's2', { reason: '手机总控面板关闭', notify: true }]);

  await control.onMessage({ chatId: 'oc_p2p', text: '结束 不存在', senderOpenId: 'ou_me' });
  assert.strictEqual(calls.at(-1)[0], 'text');
  assert.match(calls.at(-1)[2], /没找到/);
});

test('直接改名：成功与失败都回话', async () => {
  const ok = harness();
  await ok.control.onMessage({ chatId: 'oc_p2p', text: '改名 卡牌 卡牌2', senderOpenId: 'ou_me' });
  assert.deepStrictEqual(ok.renames, [{ from: '卡牌', to: '卡牌2' }]);
  assert.match(ok.calls.at(-1)[2], /已把「卡牌」改成「卡牌2」/);

  const bad = harness({ rename: () => ({ ok: false, message: '别名「卡牌」不存在。' }) });
  await bad.control.onMessage({ chatId: 'oc_p2p', text: '改名 卡牌 卡牌2', senderOpenId: 'ou_me' });
  assert.strictEqual(bad.calls.at(-1)[2], '别名「卡牌」不存在。');
});

test('点按钮改名：先问新名字，下一条文字当成新名字', async () => {
  const { control, calls, renames } = harness();
  await control.onCardAction({
    chatId: 'oc_p2p', openId: 'ou_me', action: { act: 'alias-rename', from: '卡牌' },
  });
  assert.match(calls.at(-1)[2], /改成什么/);

  await control.onMessage({ chatId: 'oc_p2p', text: '卡牌2', senderOpenId: 'ou_me' });
  assert.deepStrictEqual(renames, [{ from: '卡牌', to: '卡牌2' }]);
  assert.match(calls.at(-1)[2], /已把/);

  // 待定状态用完即清：再随口说一句不会被当成改名
  const before = renames.length;
  await control.onMessage({ chatId: 'oc_p2p', text: '卡牌3', senderOpenId: 'ou_me' });
  assert.strictEqual(renames.length, before);
  assert.match(calls.at(-1)[2], /总控面板/);
});

test('点按钮改名：新名字带空格被拒绝，且不改名', async () => {
  const { control, calls, renames } = harness();
  await control.onCardAction({
    chatId: 'oc_p2p', openId: 'ou_me', action: { act: 'alias-rename', from: '卡牌' },
  });
  await control.onMessage({ chatId: 'oc_p2p', text: '卡牌 2', senderOpenId: 'ou_me' });
  assert.deepStrictEqual(renames, []);
  assert.match(calls.at(-1)[2], /不能带空格/);
});

test('待定改名状态下发命令：按命令处理，不当成新名字', async () => {
  const { control, calls, renames } = harness();
  await control.onCardAction({
    chatId: 'oc_p2p', openId: 'ou_me', action: { act: 'alias-rename', from: '卡牌' },
  });
  await control.onMessage({ chatId: 'oc_p2p', text: '列表', senderOpenId: 'ou_me' });
  assert.deepStrictEqual(renames, []);
  assert.strictEqual(calls.at(-1)[0], 'card');
});

test('被拉进群：只对主人自我介绍，别人拉的不管', async () => {
  const { control, calls } = harness();
  await control.onBotAdded({ chatId: 'oc_g', openId: 'ou_stranger' });
  assert.deepStrictEqual(calls, []);

  await control.onBotAdded({ chatId: 'oc_g', openId: 'ou_me' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], 'card');
  assert.ok(JSON.stringify(calls[0][2]).includes('@我'));
});

test('私聊随口说话：只回帮助，不建会话', async () => {
  const { control, calls } = harness();
  await control.onMessage({ chatId: 'oc_p2p', text: '今天天气不错', senderOpenId: 'ou_me' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], 'text');
  assert.match(calls[0][2], /总控面板/);
});

test('结束：按 projects 里的新别名或按 cwd 都能找到会话', async () => {
  const a = harness({
    sessions: [{ id: 's1', alias: '卡牌', cwd: 'D:/card', agent: 'claude', status: 'idle' }],
    aliases: { 卡牌2: 'D:/card' },
  });
  await a.control.onMessage({ chatId: 'oc_p2p', text: '结束 卡牌2', senderOpenId: 'ou_me' });
  assert.deepStrictEqual(a.calls.filter((c) => c[0] === 'close'), [
    ['close', 's1', { reason: '手机总控面板关闭', notify: true }],
  ]);

  const b = harness({
    sessions: [{ id: 's2', alias: null, cwd: 'D:/w', agent: 'claude', status: 'idle' }],
    aliases: {},
  });
  await b.control.onMessage({ chatId: 'oc_p2p', text: '结束 D:/w', senderOpenId: 'ou_me' });
  assert.deepStrictEqual(b.calls.filter((c) => c[0] === 'close'), [
    ['close', 's2', { reason: '手机总控面板关闭', notify: true }],
  ]);
});

test('列表：改名后显示新别名，按钮也是新名', async () => {
  const { control, calls } = harness({
    sessions: [{ id: 's1', alias: '卡牌', cwd: 'D:/card', agent: 'claude', status: 'idle' }],
    aliases: { 卡牌2: 'D:/card' },
  });
  await control.onMessage({ chatId: 'oc_p2p', text: '列表', senderOpenId: 'ou_me' });
  const json = JSON.stringify(calls.at(-1)[2]);
  assert.ok(json.includes('卡牌2（D:/card）'));
  assert.ok(!json.includes('卡牌（D:/card）'));
  const btn = calls.at(-1)[2].body.elements.find((e) => e.tag === 'button');
  assert.deepStrictEqual(btn.behaviors[0].value, { act: 'alias-rename', from: '卡牌2' });
});

test('结束：当前别名优先于会话记录里的旧别名，不误关另一个会话', async () => {
  const { control, calls } = harness({
    sessions: [
      { id: 's1', alias: '卡牌', cwd: 'D:/A', agent: 'claude', status: 'running' },
      { id: 's2', alias: '卡牌', cwd: 'D:/B', agent: 'claude', status: 'running' },
    ],
    aliases: { 卡牌2: 'D:/A', 卡牌: 'D:/B' },
  });

  await control.onMessage({ chatId: 'oc_p2p', text: '结束 卡牌', senderOpenId: 'ou_me' });
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'close'), [
    ['close', 's2', { reason: '手机总控面板关闭', notify: true }],
  ]);

  await control.onMessage({ chatId: 'oc_p2p', text: '结束 卡牌2', senderOpenId: 'ou_me' });
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'close'), [
    ['close', 's2', { reason: '手机总控面板关闭', notify: true }],
    ['close', 's1', { reason: '手机总控面板关闭', notify: true }],
  ]);
});
