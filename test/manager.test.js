const test = require('node:test');
const assert = require('node:assert');
const { createManager } = require('../src/session/manager');

function fakeStore() {
  const map = new Map();
  return {
    map,
    load() {},
    all: () => [...map.values()],
    get: (id) => map.get(id) || null,
    getByChat: (chatId) => [...map.values()].find((s) => s.chatId === chatId) || null,
    upsert(s) { map.set(s.id, s); },
    remove(id) { map.delete(id); },
    save() {},
  };
}

function fakeApi(overrides = {}) {
  const calls = [];
  const api = {
    async sendText(chatId, text) { calls.push(['sendText', chatId, text]); },
    async sendCard(chatId, card) { calls.push(['sendCard', chatId, card]); },
    async createGroup(name, openIds) { calls.push(['createGroup', name, openIds]); return 'oc_new'; },
    async getChat() { return { chat_id: 'oc' }; },
    async disbandChat(chatId) { calls.push(['disbandChat', chatId]); },
    async createCardEntity(card) { calls.push(['createCardEntity', card]); return 'card_1'; },
    async updateCardEntity(cardId, card, seq) { calls.push(['updateCardEntity', cardId, seq, card]); },
    async sendCardEntity(chatId, cardId) { calls.push(['sendCardEntity', chatId, cardId]); },
    async downloadResource() { return Buffer.from(''); },
    ...overrides,
  };
  return { api, calls };
}

function setup({
  apiOverrides, fsApi, getProjects, now, projects,
} = {}) {
  const store = fakeStore();
  const { api, calls } = fakeApi(apiOverrides);
  const spawned = [];
  const createPtySession = (o) => {
    const ps = {
      session: o.session,
      started: false,
      submitted: [],
      confirm: false,
      start() { ps.started = true; },
      submitText(text, origin, opts) {
        const item = { text, origin };
        if (opts && opts.force) item.force = true;
        ps.submitted.push(item);
        return ps.pushResult || 'queued';
      },
      onPcKeys() {},
      needsConfirm() { return ps.confirm; },
      get screen() { return { snapshot: () => ps.screenText || '屏幕内容' }; },
      releaseTurn() {},
      kill() {},
      emit(e) { o.onEvent({ sessionId: o.session.id, ...e }); },
    };
    spawned.push(ps);
    return ps;
  };
  const manager = createManager({
    config: {
      defaultCwd: 'D:/w',
      ownerOpenId: 'ou_me',
      queueLimit: 20,
      autoDisband: false,
    },
    api,
    store,
    log: { info() {}, warn() {}, error() {} },
    createPtySession,
    mediaRoot: 'D:/media',
    now: now || (() => new Date(2026, 10, 23, 21, 40).getTime()),
    rand: () => 0,
    fsApi: fsApi || { existsSync: () => true, mkdirSync() {} },
    getProjects: getProjects || (() => ({ ...(projects || { aliases: { 卡牌: 'D:/card' }, default: 'D:/w' }) })),
  });
  return { manager, store, calls, spawned };
}

test('createFromPhone：别名命中 → 建记录、起 PTY、提交首条、回已开工卡片', async () => {
  const { manager, store, calls, spawned } = setup();
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 加个技能' });

  assert.strictEqual(rec.cwd, 'D:/card');
  assert.strictEqual(rec.alias, '卡牌');
  assert.strictEqual(rec.agent, 'claude');
  assert.strictEqual(rec.status, 'starting');
  assert.strictEqual(rec.chatId, 'oc_1');
  assert.strictEqual(store.getByChat('oc_1').id, rec.id);
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].started, true);
  assert.deepStrictEqual(spawned[0].submitted, [{ text: '加个技能', origin: 'phone' }]);

  const cardCall = calls.find((c) => c[0] === 'sendCard');
  assert.ok(cardCall[2].header.title.content.includes('已开工'));
});

test('createFromPhone：只发别名时不提交空提示词', async () => {
  const { manager, spawned } = setup();
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  assert.strictEqual(rec.cwd, 'D:/card');
  assert.deepStrictEqual(spawned[0].submitted, []);
});

test('createFromPhone：盘符路径不存在 → 回错误卡片，不建会话', async () => {
  const { manager, store, calls } = setup({
    getProjects: () => ({ aliases: {}, default: 'D:/w' }),
    fsApi: { existsSync: (p) => !p.includes('nope'), mkdirSync() {} },
  });
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: 'x', text: 'D:/nope/alpha 跑测试' });
  assert.strictEqual(rec, null);
  assert.strictEqual(store.all().length, 0);
  const cardCall = calls.find((c) => c[0] === 'sendCard');
  assert.strictEqual(cardCall[2].header.template, 'red');
});

test('createFromPhone：默认目录不存在时自动创建', async () => {
  const made = [];
  const { manager } = setup({
    getProjects: () => ({ aliases: {}, default: 'D:/w' }),
    fsApi: { existsSync: () => false, mkdirSync: (p) => made.push(p) },
  });
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: 'x', text: '随便做点什么' });
  assert.strictEqual(rec.cwd, 'D:/w');
  assert.deepStrictEqual(made, ['D:/w']);
});

test('createFromPhone：同一个群已有会话时拒绝重复建', async () => {
  const { manager } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 一' });
  await assert.rejects(
    () => manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 二' }),
    /已经有会话/,
  );
});

test('createFromPc：建群、邀请自己、发提示', async () => {
  const { manager, calls, spawned } = setup();
  const rec = await manager.createFromPc({ cwd: 'D:/card', agent: 'codex', alias: '卡牌' });
  assert.strictEqual(rec.chatId, 'oc_new');
  assert.strictEqual(rec.chatName, '卡牌 · 11-23 21:40');
  assert.deepStrictEqual(calls[0], ['createGroup', '卡牌 · 11-23 21:40', ['ou_me']]);
  assert.ok(calls.some((c) => c[0] === 'sendText' && c[2].includes('可以从手机说话')));
  assert.strictEqual(rec.agent, 'codex');
  assert.strictEqual(spawned.length, 1);
});

test('createFromPc：目录不存在时抛错', async () => {
  const { manager } = setup({ fsApi: { existsSync: () => false, mkdirSync() {} } });
  await assert.rejects(() => manager.createFromPc({ cwd: 'D:/nope' }), /目录不存在/);
});

test('PTY 事件：spawned 记 pid、ready 转 idle 并落盘', async () => {
  const { manager, store, spawned } = setup();
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 一' });
  spawned[0].emit({ type: 'spawned', pid: 4321 });
  spawned[0].emit({ type: 'ready' });
  spawned[0].emit({ type: 'input', input: { seq: 1, origin: 'phone', text: '一', at: 1 } });
  assert.strictEqual(store.get(rec.id).ptyPid, 4321);
  assert.strictEqual(store.get(rec.id).status, 'idle');
  assert.strictEqual(store.get(rec.id).lastInput.origin, 'phone');
});
