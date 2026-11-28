const test = require('node:test');
const assert = require('node:assert');
const { createManager } = require('../src/session/manager');

function fakeStore() {
  const map = new Map();
  const store = {
    map,
    saveCalls: 0,
    load() {},
    all: () => [...map.values()],
    get: (id) => map.get(id) || null,
    getByChat: (chatId) => [...map.values()].find((s) => s.chatId === chatId) || null,
    upsert(s) { map.set(s.id, s); },
    remove(id) { map.delete(id); },
    save() { store.saveCalls += 1; },
  };
  return store;
}

function fakeLog() {
  const warns = [];
  return {
    warns,
    info() {},
    warn(message, meta) { warns.push([message, meta]); },
    error() {},
  };
}

function fakeApi(overrides = {}) {
  const calls = [];
  const api = {
    async sendText(chatId, text) { calls.push(['sendText', chatId, text]); },
    async sendCard(chatId, card) { calls.push(['sendCard', chatId, card]); },
    async createGroup(name, openIds) { calls.push(['createGroup', name, openIds]); return 'oc_new'; },
    async renameChat(chatId, name) { calls.push(['renameChat', chatId, name]); },
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
  apiOverrides, fsApi, getProjects, now, projects, spawnThrows = false, ipc: ipcArg = null, configOverrides, log: logArg = null,
  runIntake = null,
} = {}) {
  const store = fakeStore();
  const { api, calls } = fakeApi(apiOverrides);
  const broadcasts = [];
  const ipc = ipcArg || { broadcast: (msg) => broadcasts.push(msg) };
  const spawned = [];
  const createPtySession = (o) => {
    const ps = {
      session: o.session,
      started: false,
      killed: false,
      submitted: [],
      confirm: false,
      start() {
        // spawnThrows 可以是布尔值，也可以是「第几次 spawn 该失败」的判定函数
        const throwNow = typeof spawnThrows === 'function' ? spawnThrows(spawned.length - 1) : spawnThrows;
        if (throwNow) throw new Error('pty 启动失败');
        ps.started = true;
      },
      submitText(text, origin, opts) {
        if (ps.throwOnSubmit && opts && opts.force) throw new Error('pty write failed');
        const item = { text, origin };
        if (opts && opts.force) item.force = true;
        ps.submitted.push(item);
        return ps.pushResult || 'queued';
      },
      onPcKeys(data) { (ps.keys || (ps.keys = [])).push(data); },
      resize(cols, rows) { (ps.resized || (ps.resized = [])).push([cols, rows]); },
      needsConfirm() { return ps.confirm; },
      snapshot() { return { id: o.session.id, chatId: o.session.chatId, agent: o.session.agent, cwd: o.session.cwd }; },
      get screen() {
        return {
          snapshot(opts) {
            ps.snapshotOpts = opts;
            return ps.screenText || '屏幕内容';
          },
        };
      },
      releaseTurn() {},
      kill() {
        ps.killed = true;
        // 模拟真实路径：kill 会同步派发 exit（真实实现不再改 session.status，由 manager 负责）
        ps.emit({ type: 'exit', code: 0 });
      },
      emit(e) { o.onEvent({ sessionId: o.session.id, ...e }); },
    };
    spawned.push(ps);
    return ps;
  };
  const log = logArg || { info() {}, warn() {}, error() {} };
  const manager = createManager({
    config: {
      defaultCwd: 'D:/w',
      ownerOpenId: 'ou_me',
      queueLimit: 20,
      autoDisband: false,
      intakeEnabled: false,
      ...configOverrides,
    },
    api,
    store,
    log,
    createPtySession,
    ipc,
    runIntake,
    mediaRoot: 'D:/media',
    now: now || (() => new Date(2026, 10, 23, 21, 40).getTime()),
    rand: () => 0,
    fsApi: fsApi || { existsSync: () => true, mkdirSync() {} },
    getProjects: getProjects || (() => ({ ...(projects || { aliases: { 卡牌: 'D:/card' }, default: 'D:/w' }) })),
  });
  return {
    manager, store, calls, spawned, broadcasts, log,
  };
}

test('createFromPhone：首条消息提 codex → 记录用 codex，提示词去掉那一段', async () => {
  const { manager, spawned } = setup();
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 用 codex 写个快排' });
  assert.strictEqual(rec.agent, 'codex');
  assert.deepStrictEqual(spawned[0].submitted, [{ text: '写个快排', origin: 'phone' }]);
});

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

test('createFromPhone：首次绑定自动把群名改成别名', async () => {
  const { manager, store, calls } = setup();
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: null, text: '卡牌 加个技能' });

  const rename = calls.find((c) => c[0] === 'renameChat');
  assert.deepStrictEqual(rename, ['renameChat', 'oc_1', '卡牌']);
  assert.strictEqual(rec.groupRenamed, true);
  assert.strictEqual(store.getByChat('oc_1').chatName, '卡牌');
});

test('createFromPhone：改群名失败不阻断建会话，只记 warn', async () => {
  const log = fakeLog();
  const { manager, spawned } = setup({
    log,
    apiOverrides: { renameChat: async () => { throw new Error('没权限'); } },
  });
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: null, text: '卡牌 加个技能' });

  assert.ok(rec);
  assert.strictEqual(spawned[0].started, true);
  assert.deepStrictEqual(spawned[0].submitted, [{ text: '加个技能', origin: 'phone' }]);
  assert.ok(log.warns.some(([m]) => m.includes('自动改群名')));
  assert.strictEqual(rec.groupRenamed, undefined, '没改成就不打标');
});

test('createFromPhone：没别名时用目录名当群名', async () => {
  const { manager, calls } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: null, text: '随便做点什么' });

  const rename = calls.find((c) => c[0] === 'renameChat');
  assert.deepStrictEqual(rename, ['renameChat', 'oc_1', 'w']);
});

test('createFromPhone：只发别名时不提交空提示词', async () => {
  const { manager, spawned } = setup();
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  assert.strictEqual(rec.cwd, 'D:/card');
  assert.deepStrictEqual(spawned[0].submitted, []);
});

test('createFromPhone：已开工卡片发送失败时仍提交首条并 resolve', async () => {
  const log = fakeLog();
  const { manager, spawned } = setup({
    log,
    apiOverrides: { sendCard: async () => { throw new Error('飞书抖了一下'); } },
  });
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 加个技能' });

  assert.ok(rec, '卡片发送失败不应让 createFromPhone reject');
  assert.deepStrictEqual(spawned[0].submitted, [{ text: '加个技能', origin: 'phone' }]);
  assert.ok(log.warns.some(([msg, meta]) => msg === '已开工卡片发送失败'
    && meta.sessionId === rec.id
    && meta.message === '飞书抖了一下'));
});

test('createFromPhone：首条提示词先入队再发卡片，连发两条不乱序', async () => {
  let releaseCard;
  const cardGate = new Promise((resolve) => { releaseCard = resolve; });
  const { manager, spawned } = setup({ apiOverrides: { sendCard: () => cardGate } });

  const p = manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 第一条' });
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '第二条', senderOpenId: 'ou_me' });
  releaseCard();
  await p;

  assert.deepStrictEqual(
    spawned[0].submitted.map((s) => s.text),
    ['第一条', '第二条'],
    '首条提示词必须先于第二条入队',
  );
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
  const before = store.saveCalls;
  spawned[0].emit({ type: 'spawned', pid: 4321 });
  spawned[0].emit({ type: 'ready' });
  spawned[0].emit({ type: 'input', input: { seq: 1, origin: 'phone', text: '一', at: 1 } });
  assert.strictEqual(store.get(rec.id).ptyPid, 4321);
  assert.strictEqual(store.get(rec.id).status, 'idle');
  assert.strictEqual(store.get(rec.id).lastInput.origin, 'phone');
  assert.strictEqual(store.saveCalls, before + 3);
});

test('onEvent：data 只广播不落盘', async () => {
  const { manager, store, spawned, broadcasts } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 一' });
  const before = store.saveCalls;
  spawned[0].emit({ type: 'data', data: 'x' });
  assert.deepStrictEqual(broadcasts[broadcasts.length - 1], {
    type: 'data',
    sessionId: spawned[0].session.id,
    data: 'x',
  });
  assert.strictEqual(store.saveCalls, before);
});

test('onEvent：落盘异常不击穿 emit，仍广播', async () => {
  const { manager, store, spawned, broadcasts } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 一' });
  store.save = () => { throw new Error('磁盘满了'); };
  assert.doesNotThrow(() => spawned[0].emit({ type: 'ready' }));
  const last = broadcasts[broadcasts.length - 1];
  assert.strictEqual(last.type, 'session');
  assert.strictEqual(last.session.status, 'idle');
});

test('createFromPhone：别名指向目录不存在 → 回目录不存在红卡并含别名', async () => {
  const { manager, store, calls } = setup({
    getProjects: () => ({ aliases: { 卡牌: 'D:/gone' }, default: 'D:/w' }),
    fsApi: { existsSync: (p) => p !== 'D:/gone', mkdirSync() {} },
  });
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 做点事' });
  assert.strictEqual(rec, null);
  assert.strictEqual(store.all().length, 0);
  const cardCall = calls.find((c) => c[0] === 'sendCard');
  assert.strictEqual(cardCall[2].header.title.content, '目录不存在');
  assert.ok(JSON.stringify(cardCall[2]).includes('卡牌'));
});

test('createFromPhone：默认目录创建失败 → 回目录创建失败红卡，不建会话', async () => {
  const { manager, store, calls } = setup({
    getProjects: () => ({ aliases: {}, default: 'D:/w' }),
    fsApi: { existsSync: () => false, mkdirSync() { throw new Error('EACCES'); } },
  });
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: 'x', text: '随便做点什么' });
  assert.strictEqual(rec, null);
  assert.strictEqual(store.all().length, 0);
  const cardCall = calls.find((c) => c[0] === 'sendCard');
  assert.strictEqual(cardCall[2].header.title.content, '目录创建失败');
  assert.ok(JSON.stringify(cardCall[2]).includes('EACCES'));
});

test('createFromPhone：spawn 抛错 → 回滚 store 与 sessions，回启动失败红卡', async () => {
  const { manager, store, calls } = setup({ spawnThrows: true });
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 一' });
  assert.strictEqual(rec, null);
  assert.strictEqual(store.getByChat('oc_1'), null);
  assert.strictEqual(store.all().length, 0);
  assert.strictEqual(manager._sessions.size, 0);
  const cardCall = calls.find((c) => c[0] === 'sendCard');
  assert.strictEqual(cardCall[2].header.title.content, '启动失败');
  assert.ok(JSON.stringify(cardCall[2]).includes('pty 启动失败'));
});

test('createFromPc：spawn 抛错 → 回滚记录、解散空群并抛错', async () => {
  const { manager, store, calls } = setup({ spawnThrows: true });
  await assert.rejects(
    () => manager.createFromPc({ cwd: 'D:/card', alias: '卡牌' }),
    /会话启动失败/,
  );
  assert.strictEqual(store.all().length, 0);
  assert.strictEqual(manager._sessions.size, 0);
  assert.ok(calls.some((c) => c[0] === 'disbandChat' && c[1] === 'oc_new'));
});

test('onPhoneMessage：未登记的群把首句当作建会话指令', async () => {
  const { manager, store, spawned } = setup();
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '卡牌 加个技能', senderOpenId: 'ou_me' });
  assert.strictEqual(store.all().length, 1);
  assert.strictEqual(store.getByChat('oc_1').cwd, 'D:/card');
  assert.deepStrictEqual(spawned[0].submitted, [{ text: '加个技能', origin: 'phone' }]);
});

test('onPhoneMessage：登记过的群直接进队列（去掉首尾空白）', async () => {
  const { manager, spawned } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '  跑一下测试  ', senderOpenId: 'ou_me' });
  assert.deepStrictEqual(spawned[0].submitted.at(-1), { text: '跑一下测试', origin: 'phone' });
});

test('onPhoneMessage：非主人的消息一律忽略', async () => {
  const { manager, spawned, calls } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  await manager.onPhoneMessage({ chatId: 'oc_1', text: 'rm -rf', senderOpenId: 'ou_other' });
  assert.strictEqual(spawned[0].submitted.length, 0);
  assert.strictEqual(calls.filter((c) => c[0] === 'sendCard').length, 1); // 只有「已开工」
});

test('onPhoneMessage：缺 senderOpenId 时按陌生人处理，不 fail-open', async () => {
  const { manager, spawned } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  await manager.onPhoneMessage({ chatId: 'oc_1', text: 'rm -rf', senderOpenId: null });
  await manager.onPhoneMessage({ chatId: 'oc_1', text: 'rm -rf', senderOpenId: '' });
  await manager.onPhoneMessage({ chatId: 'oc_1', text: 'rm -rf' });
  assert.strictEqual(spawned[0].submitted.length, 0);
});

test('onPhoneMessage：ownerOpenId 为空时谁也不能建会话', async () => {
  const { manager, store, spawned } = setup({ configOverrides: { ownerOpenId: '' } });
  await manager.onPhoneMessage({ chatId: 'oc_9', text: '卡牌 建个会话', senderOpenId: 'ou_me' });
  assert.strictEqual(spawned.length, 0);
  assert.strictEqual(store.all().length, 0);
});

test('onCardAction：openId 为空或不是主人时一律忽略', async () => {
  const { manager, spawned } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  await manager.onCardAction({ chatId: 'oc_1', openId: '', action: { act: 'force-send' } });
  await manager.onCardAction({ chatId: 'oc_1', action: { act: 'full-screen' } });
  await manager.onCardAction({ chatId: 'oc_1', openId: 'ou_other', action: { act: 'force-send' } });
  assert.strictEqual(spawned[0].submitted.length, 0);
});

test('onPhoneMessage：队列满时提示积压', async () => {
  const { manager, spawned, calls } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  spawned[0].pushResult = 'full';
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '再来一条', senderOpenId: 'ou_me' });
  assert.ok(calls.some((c) => c[0] === 'sendText' && /积压/.test(c[2])));
});

test('onPhoneMessage：不在输入框 → 回画面卡片，不写入', async () => {
  const { manager, spawned, calls } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  spawned[0].confirm = true;
  spawned[0].screenText = '❯ 1. Yes';
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });
  assert.strictEqual(spawned[0].submitted.length, 0);
  const card = calls.filter((c) => c[0] === 'sendCard').at(-1)[2];
  assert.strictEqual(card.header.title.content, '🖥 当前画面');
  assert.ok(JSON.stringify(card).includes('❯ 1. Yes'));
});

test('onPhoneMessage：回「仍然发送」强行写入上一条', async () => {
  const { manager, spawned } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  spawned[0].confirm = true;
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '仍然发送', senderOpenId: 'ou_me' });
  assert.deepStrictEqual(spawned[0].submitted, [{ text: '继续', origin: 'phone', force: true }]);
});

test('onPhoneMessage：「仍然发送」强写抛错 → 提示重发，不静默吞掉', async () => {
  const { manager, spawned, calls } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  spawned[0].confirm = true;
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });
  spawned[0].throwOnSubmit = true;

  // 强写不经过队列，pty.write 抛错没人兜底：必须回一条提示，不能只在日志里留一行
  await assert.doesNotReject(() =>
    manager.onPhoneMessage({ chatId: 'oc_1', text: '仍然发送', senderOpenId: 'ou_me' }));

  assert.ok(calls.some((c) => c[0] === 'sendText' && /重新发一次/.test(c[2])));
});

test('onPhoneMessage：媒体先落盘，再把绝对路径发给会话', async () => {
  const writes = [];
  const { manager, spawned } = setup({
    apiOverrides: { downloadResource: async () => Buffer.from('img') },
    fsApi: {
      existsSync: () => true,
      mkdirSync() {},
      writeFileSync: (p, b) => writes.push([p, b.toString()]),
    },
  });
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  await manager.onPhoneMessage({
    chatId: 'oc_1',
    text: '照这个改',
    senderOpenId: 'ou_me',
    media: { messageId: 'om_1', fileKey: 'fk_1', fileName: '截图.png', type: 'image' },
  });
  assert.deepStrictEqual(writes.map((w) => w[1]), ['img']);
  assert.ok(writes[0][0].endsWith('截图.png'));
  const sent = spawned[0].submitted.at(-1).text;
  assert.ok(sent.includes('照这个改'));
  assert.ok(sent.includes('截图.png'));
});

test('onPhoneMessage：没登记过的群首条就是图片 → 建好会话后把附件补投进去', async () => {
  const writes = [];
  const { manager, spawned } = setup({
    apiOverrides: { downloadResource: async () => Buffer.from('img') },
    fsApi: { existsSync: () => true, mkdirSync() {}, writeFileSync: (p) => writes.push(p) },
  });
  await manager.onPhoneMessage({
    chatId: 'oc_1',
    text: '',
    senderOpenId: 'ou_me',
    media: { messageId: 'om_1', fileKey: 'fk_1', fileName: '截图.png', type: 'image' },
  });

  assert.strictEqual(spawned.length, 1, '首条是附件也要把会话建起来');
  assert.strictEqual(writes.length, 1);
  const texts = spawned[0].submitted.map((s) => s.text);
  assert.strictEqual(texts.length, 1);
  assert.ok(texts[0].includes('截图.png'));
});

test('onPhoneMessage：会话已停 → 提示「重来」，不写入', async () => {
  const { manager, spawned, calls } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  spawned[0].emit({ type: 'exit', code: 1 });
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '还在吗', senderOpenId: 'ou_me' });
  assert.strictEqual(spawned[0].submitted.length, 0);
  assert.ok(calls.some((c) => c[0] === 'sendText' && /重来/.test(c[2])));
});

test('onPhoneMessage：普通消息会清掉待确认的旧文本，「仍然发送」不会复活它', async () => {
  const { manager, spawned, calls } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });

  // 先被护栏拦下，暂存「继续」
  spawned[0].confirm = true;
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });
  assert.strictEqual(spawned[0].submitted.length, 0);

  // 护栏解除后发一条普通消息：应正常入队，并清掉暂存
  spawned[0].confirm = false;
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '先做别的', senderOpenId: 'ou_me' });

  // 再发「仍然发送」：此时没有待确认文本，不能被当成强写指令把「继续」塞进去，
  // 它本身是桥接命令，也不该当正文发给 agent
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '仍然发送', senderOpenId: 'ou_me' });

  const texts = spawned[0].submitted.map((s) => s.text);
  assert.deepStrictEqual(texts, ['先做别的']);
  assert.ok(!spawned[0].submitted.some((s) => s.force === true));
  assert.ok(calls.some((c) => c[0] === 'sendText' && /没有等待确认/.test(c[2])));
});

test('onPhoneMessage：没登记过的群里发「仍然发送」不会建会话', async () => {
  const { manager, spawned, store, calls } = setup();
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '仍然发送', senderOpenId: 'ou_me' });
  assert.strictEqual(spawned.length, 0);
  assert.strictEqual(store.all().length, 0);
  assert.ok(calls.some((c) => c[0] === 'sendText' && /没有等待确认/.test(c[2])));
});

test('onPhoneMessage：会话重开过，旧的「仍然发送」暂存作废', async () => {
  const { manager, spawned, calls } = setup();
  const old = await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  spawned[0].confirm = true;
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });

  await manager.closeSession(old.id, { reason: 'test' });
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });

  await manager.onPhoneMessage({ chatId: 'oc_1', text: '仍然发送', senderOpenId: 'ou_me' });
  assert.ok(!spawned.some((ps) => ps.submitted.some((s) => s.force === true)));
  assert.ok(calls.some((c) => c[0] === 'sendText' && /没有等待确认/.test(c[2])));
});

test('onPhoneMessage：submitText 发现会话刚断开 → 提示「重来」，不静默吞掉', async () => {
  const { manager, spawned, calls } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  spawned[0].pushResult = 'closed';
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '还在吗', senderOpenId: 'ou_me' });
  assert.ok(calls.some((c) => c[0] === 'sendText' && /重来/.test(c[2])));
});

test('onPhoneMessage：同群并发消息按到达顺序处理，媒体下载慢也不插队', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { manager, spawned } = setup({
    apiOverrides: { downloadResource: async () => { await gate; return Buffer.from('img'); } },
    fsApi: { existsSync: () => true, mkdirSync() {}, writeFileSync() {} },
  });
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });

  const first = manager.onPhoneMessage({
    chatId: 'oc_1',
    text: '看这张图',
    senderOpenId: 'ou_me',
    media: { messageId: 'om_1', fileKey: 'fk_1', fileName: '图.png', type: 'image' },
  });
  const second = manager.onPhoneMessage({ chatId: 'oc_1', text: '算了', senderOpenId: 'ou_me' });
  release();
  await Promise.all([first, second]);

  const texts = spawned[0].submitted.map((s) => s.text);
  assert.strictEqual(texts.length, 2);
  assert.ok(texts[0].startsWith('看这张图'));
  assert.strictEqual(texts[1], '算了');
});

async function started(props) {
  const h = setup(props);
  const rec = await h.manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 你好' });
  h.spawned[0].emit({ type: 'ready' });
  return { ...h, rec };
}

test('Stop：手机来源只推回复，不重复用户输入', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].emit({ type: 'input', input: { seq: 1, origin: 'phone', text: '现在几点', at: 1 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '十点半。' } });

  const card = calls.filter((c) => c[0] === 'sendCard').at(-1)[2];
  const body = JSON.stringify(card.body);
  assert.ok(body.includes('十点半。'));
  assert.ok(!body.includes('你刚在电脑上问'));
  assert.ok(!body.includes('现在几点'));
});

test('Stop：电脑来源顶部带 🖥 行', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].emit({ type: 'pc-input', input: { seq: 2, origin: 'pc', text: '现在几点', at: 2 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '十点半。' } });

  const body = JSON.stringify(calls.filter((c) => c[0] === 'sendCard').at(-1)[2].body);
  assert.ok(body.includes('🖥 你刚在电脑上问：现在几点'));
  assert.ok(body.includes('十点半。'));
});

test('Stop：releaseTurn 同步泵出下一条时，回复仍挂在原来那句电脑提问上', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].emit({ type: 'pc-input', input: { seq: 2, origin: 'pc', text: '现在几点', at: 2 } });
  // 本轮还没结束时手机又发来一条，它排在队列里
  spawned[0].emit({ type: 'input', input: { seq: 3, origin: 'phone', text: '顺便跑个测试', at: 3 } });
  // 真实 ptySession 的 releaseTurn 会同步把队列里的下一条写进去并派发新的 turn-start，
  // 那一笔会立刻覆盖 turnInputs；Stop 里的归属必须在调用 releaseTurn 之前就读出来。
  spawned[0].releaseTurn = () => spawned[0].emit({ type: 'turn-start', seq: 3, origin: 'phone', text: '顺便跑个测试' });

  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '十点半。' } });

  const body = JSON.stringify(calls.filter((c) => c[0] === 'sendCard').at(-1)[2].body);
  assert.ok(body.includes('🖥 你刚在电脑上问：现在几点'), '回复必须挂在电脑上问的那句后面');
  assert.ok(!body.includes('顺便跑个测试'), '下一条消息不能显示成本轮提问');
});

test('会话进程退出时排队丢失的消息会提示重新发送', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].emit({ type: 'queue-dropped', items: [{ seq: 2, origin: 'phone', text: '一' }, { seq: 3, origin: 'phone', text: '二' }] });
  await manager._drain();

  const sent = calls.filter((c) => c[0] === 'sendText').map((c) => c[2]);
  assert.ok(sent.includes('排队里的 2 条消息没能送进去（会话进程退出了），重新发一次吧。'));
  assert.strictEqual(rec.id, spawned[0].session.id);
});

test('Stop：输入为空（只按了回车）不推', async () => {
  const { manager, calls, spawned, rec } = await started();
  const before = calls.filter((c) => c[0] === 'sendCard').length;
  spawned[0].emit({ type: 'input', input: { seq: 1, origin: 'phone', text: '   ', at: 1 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '好的' } });
  assert.strictEqual(calls.filter((c) => c[0] === 'sendCard').length, before);
});

test('Stop：斜杠命令同样作为电脑来源推回', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].emit({ type: 'pc-input', input: { seq: 2, origin: 'pc', text: '/compact', at: 2 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '已压缩 12 条消息' } });

  const body = JSON.stringify(calls.filter((c) => c[0] === 'sendCard').at(-1)[2].body);
  assert.ok(body.includes('🖥 你刚在电脑上问：/compact'));
});

test('Stop：超过 8000 字的回复走截断', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].emit({ type: 'input', input: { seq: 1, origin: 'phone', text: '写长一点', at: 1 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '字'.repeat(9000) } });

  const card = calls.filter((c) => c[0] === 'sendCard').at(-1)[2];
  assert.strictEqual(card.header.title.content, '✅ 回复（已截断）');
});

test('Stop：正文带上工具摘要行', async () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { content: '改地形' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: 'D:/card/a.gd' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'D:/card/b.gd' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    }),
  ].join('\n');
  const { manager, calls, spawned, rec } = await started({
    fsApi: {
      existsSync: () => true,
      mkdirSync() {},
      statSync: () => ({ size: jsonl.length }),
      readFileSync: () => jsonl,
    },
  });
  spawned[0].emit({ type: 'input', input: { seq: 1, origin: 'phone', text: '改地形', at: 1 } });
  await manager.onHookStop({
    sessionId: rec.id,
    payload: { transcript_path: 'D:/t.jsonl', last_assistant_message: '改好了' },
  });

  const body = JSON.stringify(calls.filter((c) => c[0] === 'sendCard').at(-1)[2].body);
  assert.ok(body.includes('改了 2 个文件'));
  assert.ok(body.includes('Bash×1'));
});

test('Stop：画面停在 Interrupted 且没有正文 → 推「（已打断）」', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].screenText = '⎿  Interrupted · What should Claude do instead?';
  spawned[0].emit({ type: 'input', input: { seq: 1, origin: 'pc', text: '跑很久的任务', at: 1 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '' } });

  const body = JSON.stringify(calls.filter((c) => c[0] === 'sendCard').at(-1)[2].body);
  assert.ok(body.includes('（已打断）'));
  assert.deepStrictEqual(spawned[0].snapshotOpts, { lines: 12 });
});

test('turn-start 建处理中卡片，Stop 原地定稿', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].emit({ type: 'turn-start', seq: 2, origin: 'phone', text: '跑测试' });
  await manager._drain();

  assert.ok(calls.some((c) => c[0] === 'createCardEntity'));
  assert.ok(calls.some((c) => c[0] === 'sendCardEntity' && c[2] === 'card_1'));

  spawned[0].emit({ type: 'input', input: { seq: 2, origin: 'phone', text: '跑测试', at: 2 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '全绿' } });

  const upd = calls.find((c) => c[0] === 'updateCardEntity');
  assert.strictEqual(upd[1], 'card_1');
  assert.strictEqual(upd[2], 1);
  assert.ok(JSON.stringify(upd[3].body).includes('全绿'));
  assert.strictEqual(calls.filter((c) => c[0] === 'sendCard').length, 1);   // 只有「已开工」
});

test('Stop：回填 claudeSessionId 与 transcriptPath，状态转 idle', async () => {
  const { manager, store, spawned, rec } = await started();
  spawned[0].emit({ type: 'turn-start', seq: 2, origin: 'phone', text: '一' });
  await manager._drain();
  assert.strictEqual(store.get(rec.id).status, 'running');

  await manager.onHookStop({
    sessionId: rec.id,
    payload: { session_id: 'cs_9', transcript_path: 'D:/t.jsonl', last_assistant_message: '完' },
  });

  const saved = store.get(rec.id);
  assert.strictEqual(saved.claudeSessionId, 'cs_9');
  assert.strictEqual(saved.transcriptPath, 'D:/t.jsonl');
  assert.strictEqual(saved.status, 'idle');
});

test('Stop：桥梁 sessionId 对不上时，用 payload.session_id 兜底找会话', async () => {
  const { manager, calls, store, spawned, rec } = await started();
  store.get(rec.id).claudeSessionId = 'cs_1';
  spawned[0].emit({ type: 'input', input: { seq: 1, origin: 'phone', text: '一', at: 1 } });
  await manager.onHookStop({ sessionId: 's_unknown', payload: { session_id: 'cs_1', last_assistant_message: '找到了' } });

  const body = JSON.stringify(calls.filter((c) => c[0] === 'sendCard').at(-1)[2].body);
  assert.ok(body.includes('找到了'));
});

test('Stop：找不到任何会话时静默返回', async () => {
  const { manager, calls } = setup();
  await manager.onHookStop({ sessionId: 's_none', payload: { last_assistant_message: '幽灵' } });
  assert.strictEqual(calls.length, 0);
});

test('Stop：最后输入为空时收尾处理中卡片并落盘', async () => {
  const { manager, store, calls, spawned, rec } = await started();
  spawned[0].emit({ type: 'turn-start', seq: 2, origin: 'phone', text: '一' });
  await manager._drain();
  assert.ok(rec.pendingCard && rec.pendingCard.cardId === 'card_1');

  const savesBefore = store.saveCalls;
  // 空回车只可能来自电脑端（手机端空白消息在 onPhoneMessage 就被丢掉了）
  spawned[0].emit({ type: 'pc-input', input: { seq: 2, origin: 'pc', text: '   ', at: 2 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '好的' } });

  assert.strictEqual(rec.pendingCard, null);
  const ups = calls.filter((c) => c[0] === 'updateCardEntity');
  assert.strictEqual(ups.length, 1);
  assert.strictEqual(ups[0][1], 'card_1');
  assert.ok(JSON.stringify(ups[0][3].body).includes('本轮只按了回车'));
  assert.ok(store.saveCalls > savesBefore);
});

test('Stop：无回复且未打断时收尾处理中卡片', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].emit({ type: 'turn-start', seq: 2, origin: 'phone', text: '一' });
  await manager._drain();
  assert.ok(rec.pendingCard && rec.pendingCard.cardId === 'card_1');
  assert.ok(!spawned[0].snapshotOpts, '此时还没查过画面');

  spawned[0].emit({ type: 'input', input: { seq: 2, origin: 'phone', text: '一', at: 2 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '' } });

  assert.strictEqual(rec.pendingCard, null);
  const upd = calls.find((c) => c[0] === 'updateCardEntity');
  assert.ok(upd);
  assert.strictEqual(upd[1], 'card_1');
  assert.ok(JSON.stringify(upd[3].body).includes('本轮没有文字输出'));
});

test('Stop 先到：慢建卡不会发出过期卡', async () => {
  const created = [];
  const { manager, calls, spawned, rec } = await started({
    apiOverrides: {
      createCardEntity: async () => {
        await new Promise((r) => setTimeout(r, 20));
        created.push('card_slow');
        return 'card_slow';
      },
    },
  });

  spawned[0].emit({ type: 'turn-start', seq: 2, origin: 'phone', text: '慢' });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '先结束' } });
  await manager._drain();

  assert.deepStrictEqual(created, ['card_slow']);
  assert.ok(!calls.some((c) => c[0] === 'sendCardEntity' && c[2] === 'card_slow'));
  assert.strictEqual(rec.pendingCard, null);
});

test('Stop：卡片定稿更新失败会原地重试一次，不重复发卡', async () => {
  let updateCalls = 0;
  const { manager, calls, spawned, rec } = await started({
    apiOverrides: {
      updateCardEntity: async (cardId, card, seq) => {
        updateCalls += 1;
        calls.push(['updateCardEntity', cardId, seq, card]);
        if (updateCalls === 1) throw new Error('飞书抖了一下');
      },
    },
  });
  spawned[0].emit({ type: 'turn-start', seq: 2, origin: 'phone', text: '一' });
  await manager._drain();
  spawned[0].emit({ type: 'input', input: { seq: 2, origin: 'phone', text: '一', at: 2 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '好了' } });

  assert.strictEqual(updateCalls, 2);
  assert.strictEqual(calls.filter((c) => c[0] === 'sendCard').length, 1); // 只有「已开工」
});

test('Stop：原地重试仍失败才改发新卡', async () => {
  let updateCalls = 0;
  const { manager, calls, spawned, rec } = await started({
    apiOverrides: {
      updateCardEntity: async () => {
        updateCalls += 1;
        throw new Error('一直失败');
      },
    },
  });
  spawned[0].emit({ type: 'turn-start', seq: 2, origin: 'phone', text: '一' });
  await manager._drain();
  spawned[0].emit({ type: 'input', input: { seq: 2, origin: 'phone', text: '一', at: 2 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '好了' } });

  assert.strictEqual(updateCalls, 2);
  assert.ok(calls.some((c) => c[0] === 'sendCard' && JSON.stringify(c[2]).includes('好了')));
});

test('enqueueWork：建卡失败后队列仍能继续处理下一次 turn-start', async () => {
  let createCalls = 0;
  const { manager, spawned, rec } = await started({
    apiOverrides: {
      createCardEntity: async () => {
        createCalls += 1;
        throw new Error('建卡失败');
      },
    },
  });

  spawned[0].emit({ type: 'turn-start', seq: 2, origin: 'phone', text: '一' });
  spawned[0].emit({ type: 'turn-start', seq: 3, origin: 'phone', text: '二' });
  await manager._drain();

  assert.strictEqual(createCalls, 2);
  assert.ok(!rec.pendingCard);
});

test('onDisbanded：杀 PTY、移除记录、窗口收到 closed', async () => {
  const broadcasts = [];
  const { manager, store, spawned, rec } = await started({ ipc: { broadcast: (m) => broadcasts.push(m) } });
  await manager.onDisbanded({ chatId: 'oc_1' });

  assert.strictEqual(spawned[0].killed, true);
  assert.strictEqual(store.get(rec.id), null);
  assert.ok(broadcasts.some((m) => m.type === 'session' && m.session.status === 'closed'));
});

test('onDisbanded：没登记的群静默返回', async () => {
  const { manager, spawned } = setup();
  await manager.onDisbanded({ chatId: 'oc_none' });
  assert.strictEqual(spawned.length, 0);
});

test('onBotRemoved：等同解散', async () => {
  const { manager, store, spawned, rec } = await started();
  await manager.onBotRemoved({ chatId: 'oc_1' });
  assert.strictEqual(spawned[0].killed, true);
  assert.strictEqual(store.get(rec.id), null);
});

test('PTY 崩溃：状态转 error，群里收到异常卡片', async () => {
  const { manager, calls, store, spawned, rec } = await started();
  spawned[0].emit({ type: 'exit', code: 1 });
  await manager._drain();

  assert.strictEqual(store.get(rec.id).status, 'error');
  const card = calls.filter((c) => c[0] === 'sendCard').at(-1)[2];
  assert.ok(card.header.title.content.includes('异常退出'));
  assert.ok(JSON.stringify(card).includes('code 1'));
  assert.ok(JSON.stringify(card).includes('重来'));
});

test('回「重来」：目录还在就重新拉起 PTY', async () => {
  const { manager, store, spawned, rec } = await started();
  spawned[0].emit({ type: 'exit', code: 2 });
  await manager._drain();
  assert.strictEqual(store.get(rec.id).status, 'error');

  await manager.onPhoneMessage({ chatId: 'oc_1', text: '重来', senderOpenId: 'ou_me' });

  assert.strictEqual(spawned.length, 2);
  assert.strictEqual(spawned[1].started, true);
  assert.strictEqual(store.get(rec.id).status, 'starting');
});

test('回「重来」：原目录不在了就报错，不再拉起', async () => {
  let gone = false;
  const { manager, calls, spawned } = await started({
    fsApi: { existsSync: () => !gone, mkdirSync() {} },
  });
  spawned[0].emit({ type: 'exit', code: 2 });
  await manager._drain();
  gone = true;

  await manager.onPhoneMessage({ chatId: 'oc_1', text: '重来', senderOpenId: 'ou_me' });

  assert.strictEqual(spawned.length, 1);
  const card = calls.filter((c) => c[0] === 'sendCard').at(-1)[2];
  assert.ok(card.header.title.content.includes('目录'));
});

test('tick：群已不存在 → 关闭会话；群还在 → 不动', async () => {
  let existing = true;
  const { manager, store, spawned, rec } = await started({
    apiOverrides: { getChat: async () => (existing ? { chat_id: 'oc_1' } : null) },
  });

  await manager.tick();
  assert.strictEqual(spawned[0].killed, false);

  existing = false;
  await manager.tick();
  assert.strictEqual(spawned[0].killed, true);
  assert.strictEqual(store.get(rec.id), null);
});

test('onCardAction：force-send 按钮等同「仍然发送」', async () => {
  const { manager, spawned } = await started();
  spawned[0].confirm = true;
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });

  await manager.onCardAction({ chatId: 'oc_1', openId: 'ou_me', action: { act: 'force-send' } });

  assert.deepStrictEqual(spawned[0].submitted.at(-1), { text: '继续', origin: 'phone', force: true });
});

test('closeSession：notify 时群发「会话已结束」，autoDisband 打开则解散群', async () => {
  const { manager, calls, rec } = await started({ configOverrides: { autoDisband: true } });
  await manager.closeSession(rec.id, { reason: 'window', notify: true });

  assert.ok(calls.some((c) => c[0] === 'sendText' && c[2].includes('会话已结束')));
  assert.ok(calls.some((c) => c[0] === 'disbandChat' && c[1] === 'oc_1'));
});

test('closeSession：主动关闭不会误报进程崩溃', async () => {
  const { manager, calls, spawned, rec } = await started();
  await manager.closeSession(rec.id, { notify: true });
  await manager._drain();

  assert.strictEqual(spawned[0].killed, true);
  assert.strictEqual(spawned[0].session.status, 'closed');
  assert.strictEqual(manager._sessions.size, 0);
  assert.ok(!calls.some((c) => c[0] === 'sendCard' && c[2].header.title.content.includes('进程异常退出')));
  assert.ok(calls.some((c) => c[0] === 'sendText' && c[2].includes('会话已结束')));
});

test('restoreAll：记录转 interrupted、逐群提示、不拉起 PTY', async () => {
  const { manager, store, calls, spawned, rec } = await started();
  manager._sessions.clear();   // 模拟 daemon 重启：内存里的 PTY 全没了

  const n = await manager.restoreAll();

  assert.strictEqual(n, 1);
  assert.strictEqual(store.get(rec.id).status, 'interrupted');
  assert.strictEqual(spawned.length, 1);
  assert.ok(calls.some((c) => c[0] === 'sendText' && c[2].includes('电脑重启了')));
});

test('restoreAll：closed 的记录直接清掉', async () => {
  const { manager, store } = setup();
  store.upsert({ id: 's_old', chatId: 'oc_9', status: 'closed', agent: 'claude', cwd: 'D:/w' });

  await manager.restoreAll();

  assert.strictEqual(store.get('s_old'), null);
});

test('interrupted 会话收到消息：重开并投递这条消息', async () => {
  const { manager, spawned } = await started();
  manager._sessions.clear();   // 模拟 daemon 重启：内存里的 PTY 全没了
  await manager.restoreAll();

  await manager.onPhoneMessage({ chatId: 'oc_1', text: '接着干', senderOpenId: 'ou_me' });

  assert.strictEqual(spawned.length, 2);
  assert.deepStrictEqual(spawned[1].submitted.at(-1), { text: '接着干', origin: 'phone' });
});

test('interrupted + claudeSessionId：重开带着它（--resume 由 launcher 加）', async () => {
  const { manager, store, spawned, rec } = await started();
  rec.claudeSessionId = 'cs_1';
  store.save();
  manager._sessions.clear();   // 模拟 daemon 重启：内存里的 PTY 全没了
  await manager.restoreAll();

  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });

  assert.strictEqual(spawned[1].session.claudeSessionId, 'cs_1');
  assert.strictEqual(spawned[1].session.resuming, true);
});

test('--resume 失败：清掉旧会话 ID，改用新会话重建', async () => {
  const { manager, store, calls, spawned, rec } = await started();
  rec.claudeSessionId = 'cs_1';
  store.save();
  manager._sessions.clear();   // 模拟 daemon 重启：内存里的 PTY 全没了
  await manager.restoreAll();
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });

  spawned[1].emit({ type: 'exit', code: 1 });
  await manager._drain();

  assert.strictEqual(store.get(rec.id).claudeSessionId, null);
  assert.strictEqual(spawned.length, 3);
  assert.ok(calls.some((c) => c[0] === 'sendText' && c[2].includes('改用新会话重建')));
});

test('interrupted 状态回「重来」：直接重启，不把「重来」当提示词', async () => {
  const { manager, spawned } = await started();
  manager._sessions.clear();   // 模拟 daemon 重启：内存里的 PTY 全没了
  await manager.restoreAll();

  await manager.onPhoneMessage({ chatId: 'oc_1', text: '重来', senderOpenId: 'ou_me' });

  assert.strictEqual(spawned.length, 2);
  assert.strictEqual(spawned[1].submitted.length, 0);
});

test('resume 成功启动后再崩溃：按普通崩溃处理，不丢会话 ID', async () => {
  const { manager, store, calls, spawned, rec } = await started();
  rec.claudeSessionId = 'cs_1';
  store.save();
  manager._sessions.clear();   // 模拟 daemon 重启：内存里的 PTY 全没了
  await manager.restoreAll();
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });

  spawned[1].emit({ type: 'ready' });
  await manager._drain();
  spawned[1].emit({ type: 'exit', code: 1 });
  await manager._drain();

  assert.strictEqual(store.get(rec.id).claudeSessionId, 'cs_1');
  assert.strictEqual(spawned.length, 2);
  assert.ok(calls.some((c) => c[0] === 'sendCard' && c[2].header.title.content.includes('进程异常退出')));
  assert.ok(!calls.some((c) => c[0] === 'sendText' && c[2].includes('改用新会话重建')));
});

test('restoreAll：落盘失败不中断恢复，其余会话照常标记', async () => {
  const h = await started();
  const { manager, store, calls } = h;
  const second = { ...h.rec, id: 's_second', chatId: 'oc_second' };
  store.upsert(second);
  const closed = { ...h.rec, id: 's_closed', chatId: 'oc_closed', status: 'closed' };
  store.upsert(closed);
  store.remove = () => { throw new Error('disk full'); };
  store.save = () => { throw new Error('disk full'); };
  manager._sessions.clear();   // 模拟 daemon 重启：内存里的 PTY 全没了

  let restored;
  await assert.doesNotReject(async () => {
    restored = await manager.restoreAll();
  });

  assert.strictEqual(restored, 2);
  assert.strictEqual(store.get(second.id).status, 'interrupted');
  assert.strictEqual(store.get(second.id).ptyPid, null);
  const prompts = calls.filter((c) => c[0] === 'sendText' && c[2] === '电脑重启了，回一条消息我就接上。');
  assert.strictEqual(prompts.length, 2);
});

test('codex turn-end：把最近画面推回群里，电脑来源带 🖥 引言行', async () => {
  const h = setup();
  const rec = await h.manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 codex 写个快排' });
  const ps = h.spawned[0];
  ps.emit({ type: 'ready' });
  ps.emit({ type: 'turn-start', text: '帮我写快排' });
  ps.emit({ type: 'pc-input', input: { seq: 2, origin: 'pc', text: '帮我写快排', at: 2 } });
  ps.screenText = 'def quicksort():\n    pass';
  ps.emit({ type: 'turn-end' });
  await h.manager._drain();

  const card = h.calls.filter((c) => c[0] === 'sendCard').at(-1)[2];
  const body = JSON.stringify(card.body);
  assert.ok(body.includes('你刚在电脑上问：帮我写快排'));
  assert.ok(body.includes('def quicksort'));
  assert.strictEqual(h.store.get(rec.id).status, 'idle');
});

test('codex turn-end：推送前切掉输入框和页脚', async () => {
  const h = setup();
  await h.manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 codex 写个快排' });
  const ps = h.spawned[0];
  ps.emit({ type: 'ready' });
  ps.emit({ type: 'turn-start', text: '写个快排' });
  ps.screenText = [
    '• 好的：',
    '  def quicksort(x):',
    '      return x',
    '› Ask Codex to do anything',
    'gpt-5.1-codex high · D:/w',
    '? for shortcuts',
  ].join('\n');
  ps.emit({ type: 'turn-end' });
  await h.manager._drain();

  const body = JSON.stringify(h.calls.filter((c) => c[0] === 'sendCard').at(-1)[2].body);
  assert.ok(body.includes('def quicksort'));
  assert.ok(!body.includes('Ask Codex to do anything'), '输入框占位符不应进卡片');
  assert.ok(!body.includes('for shortcuts'), '页脚不应进卡片');
});

test('onCardAction：full-screen 回最近 200 行画面', async () => {
  const { manager, calls, spawned } = await started();
  spawned[0].screenText = '第 1 行\n第 200 行';
  await manager.onCardAction({ chatId: 'oc_1', openId: 'ou_me', action: { act: 'full-screen', lines: 200 } });

  const card = calls.filter((c) => c[0] === 'sendCard').at(-1)[2];
  assert.ok(card.header.title.content.includes('200'));
  assert.ok(JSON.stringify(card.body).includes('第 200 行'));
});

test('onCardAction：会话已停时 full-screen 回提示', async () => {
  const { manager, calls, spawned } = await started();
  spawned[0].emit({ type: 'exit', code: 1 });
  await manager._drain();

  await manager.onCardAction({ chatId: 'oc_1', openId: 'ou_me', action: { act: 'full-screen' } });
  assert.ok(calls.some((c) => c[0] === 'sendText' && c[2].includes('会话已经停了')));
});

test('codex 画面推送：claude 会话收到 turn-end 不推画面卡', async () => {
  const { manager, calls, spawned, rec } = await started();
  assert.strictEqual(rec.agent, 'claude');

  spawned[0].emit({ type: 'turn-end' });
  await manager._drain();

  const pushed = calls.filter((c) => c[0] === 'sendCard'
    && c[2].header && c[2].header.title.content.includes('Codex 输出'));
  assert.strictEqual(pushed.length, 0, 'claude 会话不得推 codex 画面卡');
});

test('onCardAction：interrupted 会话 full-screen 只回提示，不推卡', async () => {
  const { manager, store, calls, rec } = await started();
  store.get(rec.id).status = 'interrupted';
  const before = calls.length;

  await manager.onCardAction({ chatId: 'oc_1', openId: 'ou_me', action: { act: 'full-screen' } });

  assert.ok(calls.slice(before).some((c) => c[0] === 'sendText'
    && c[2] === '会话已经停了，看不到完整画面了。'));
  assert.strictEqual(calls.slice(before).filter((c) => c[0] === 'sendCard').length, 0);
});

test('onCardAction：full-screen 的 lines 取整并夹取到 [40, 500]', async () => {
  const { manager, spawned } = await started();

  for (const [input, expected] of [['40.5', 40], [1000, 500], ['abc', 200]]) {
    await manager.onCardAction({
      chatId: 'oc_1', openId: 'ou_me', action: { act: 'full-screen', lines: input },
    });
    assert.strictEqual(spawned[0].snapshotOpts.lines, expected, `lines=${input}`);
    assert.ok(Number.isInteger(spawned[0].snapshotOpts.lines), 'lines 必须是整数');
  }
});

test('codex turn-end：取画面抛错时不推卡也不抛', async () => {
  const h = setup();
  await h.manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 codex 写个快排' });
  const ps = h.spawned[0];
  ps.emit({ type: 'ready' });
  Object.defineProperty(ps, 'screen', {
    get: () => ({ snapshot() { throw new Error('boom'); } }),
  });
  const before = h.calls.length;

  ps.emit({ type: 'turn-end' });
  await assert.doesNotReject(h.manager._drain());

  assert.strictEqual(h.calls.slice(before).filter((c) => c[0] === 'sendCard').length, 0);
});

test('onPcKeys：转发电脑按键，忽略空数据与未知会话', async () => {
  const { manager, spawned } = await started();
  const id = spawned[0].session.id;
  manager.onPcKeys({ sessionId: id, data: 'a' });
  manager.onPcKeys({ sessionId: id, data: '' });
  manager.onPcKeys({ sessionId: id });
  manager.onPcKeys({ sessionId: 'nope', data: 'b' });
  assert.deepStrictEqual(spawned[0].keys, ['a']);
});

test('onPcResize：转发合法尺寸，忽略非法尺寸与未知会话', async () => {
  const { manager, spawned } = await started();
  const id = spawned[0].session.id;
  manager.onPcResize({ sessionId: id, cols: 120, rows: 40 });
  manager.onPcResize({ sessionId: id, cols: 0, rows: 40 });
  manager.onPcResize({ sessionId: 'nope', cols: 10, rows: 10 });
  assert.deepStrictEqual(spawned[0].resized, [[120, 40]]);
});

test('replayFor：返回活会话的屏幕快照，未知会话/不支持时为空串', async () => {
  const { manager, spawned } = await started();
  const id = spawned[0].session.id;
  spawned[0].replay = () => '\x1b[32mhi\x1b[0m';
  assert.strictEqual(manager.replayFor(id), '\x1b[32mhi\x1b[0m');
  assert.strictEqual(manager.replayFor('nope'), '');
  delete spawned[0].replay;
  assert.strictEqual(manager.replayFor(id), '');
});

test('list：活会话叠加快照，退出后状态为 error', async () => {
  const { manager, spawned, rec } = await started();
  const live = manager.list().find((s) => s.id === rec.id);
  assert.strictEqual(live.status, 'idle');
  assert.strictEqual(live.cwd, 'D:/card');

  spawned[0].emit({ type: 'exit', code: 1 });
  await manager._drain();
  const dead = manager.list().find((s) => s.id === rec.id);
  assert.strictEqual(dead.status, 'error');
});

test('shutdown：杀 PTY、标记 interrupted、不解散群也不推崩溃卡', async () => {
  const broadcasts = [];
  // 按广播时刻快照会话：record 是活对象，shutdown 随后会把 status 改成 interrupted，
  // 直接存引用会掩盖「关机瞬间短暂 error」的现场。
  const ipc = {
    broadcast: (msg) => broadcasts.push(
      msg && msg.type === 'session' ? { type: msg.type, session: { ...msg.session } } : msg,
    ),
  };
  const { manager, calls, store, spawned, rec } = await started({ ipc });
  calls.length = 0;   // 清掉建会话时的「已开工」卡，只看停机阶段发出的调用
  spawned[0].kill = () => {
    spawned[0].killed = true;
    spawned[0].emit({ type: 'exit', code: 1 });
  };
  await manager.shutdown();
  await manager._drain();

  assert.strictEqual(spawned[0].killed, true);
  assert.strictEqual(store.get(rec.id).status, 'interrupted');
  assert.strictEqual(store.get(rec.id).ptyPid, null);
  assert.ok(!calls.some((c) => c[0] === 'disbandChat'));
  assert.ok(!calls.some((c) => c[0] === 'sendCard'));
  assert.ok(
    !broadcasts.some((m) => m.type === 'session' && m.session.status === 'error'),
    '关机瞬间不应向窗口/手机广播 error 状态',
  );
});

test('shutdown：落盘失败不击穿，会话仍标 interrupted 并有 warn', async () => {
  const log = fakeLog();
  const { manager, store, spawned, rec } = await started({ log });
  spawned[0].kill = () => {
    spawned[0].killed = true;
    spawned[0].emit({ type: 'exit', code: 1 });
  };
  store.save = () => { throw new Error('磁盘满了'); };

  await assert.doesNotReject(() => manager.shutdown());

  assert.strictEqual(spawned[0].killed, true);
  assert.strictEqual(store.get(rec.id).status, 'interrupted');
  assert.strictEqual(manager._sessions.size, 0);
  assert.ok(log.warns.some(([msg]) => msg === '停机落盘失败'));
});

test('无头接待：群名与首条指令用接待结论，交接块带原话和备注', async () => {
  const { manager, calls, spawned } = setup({
    configOverrides: { intakeEnabled: true },
    runIntake: async () => ({
      cwd: 'D:/card', groupName: '卡牌技能', prompt: '给卡牌加一个技能', note: '按别名定位',
    }),
  });
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: null, text: '卡牌 加个技能' });

  assert.strictEqual(rec.cwd, 'D:/card');
  assert.strictEqual(rec.groupName, '卡牌技能');
  assert.strictEqual(spawned[0].submitted.length, 1);
  const first = spawned[0].submitted[0].text;
  assert.ok(first.includes('用户原话「卡牌 加个技能」'));
  assert.ok(first.includes('工作目录 D:/card'));
  assert.ok(first.includes('按别名定位'));
  assert.ok(first.endsWith('给卡牌加一个技能'));

  assert.deepStrictEqual(calls.find((c) => c[0] === 'renameChat'), ['renameChat', 'oc_1', '卡牌技能']);
  assert.strictEqual(rec.groupRenamed, true);
  const card = calls.find((c) => c[0] === 'sendCard')[2];
  assert.ok(JSON.stringify(card).includes('按别名定位'));
});

test('无头接待失败：照常建会话，首条用规则结果', async () => {
  const { manager, spawned } = setup({
    configOverrides: { intakeEnabled: true },
    runIntake: async () => { throw new Error('超时'); },
  });
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: null, text: '卡牌 加个技能' });
  assert.ok(rec);
  assert.strictEqual(rec.groupName, null);
  assert.deepStrictEqual(spawned[0].submitted, [{ text: '加个技能', origin: 'phone' }]);
});

test('无头接待关闭：完全不调用 runner', async () => {
  let called = 0;
  const { manager } = setup({ runIntake: async () => { called += 1; } });
  await manager.createFromPhone({ chatId: 'oc_1', chatName: null, text: '卡牌 加个技能' });
  assert.strictEqual(called, 0);
});

test('无头接待期间连发两条：只建一个会话，后续消息补投进去', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { manager, spawned } = setup({
    configOverrides: { intakeEnabled: true },
    runIntake: async () => { await gate; return { groupName: '卡牌技能', prompt: '给卡牌加一个技能' }; },
  });

  const first = manager.createFromPhone({ chatId: 'oc_1', chatName: null, text: '卡牌 加个技能' });
  await new Promise((r) => setImmediate(r));
  const second = manager.createFromPhone({ chatId: 'oc_1', chatName: null, text: '顺便加个测试' });
  release();
  await Promise.all([first, second]);

  assert.strictEqual(spawned.length, 1);
  const texts = spawned[0].submitted.map((s) => s.text);
  assert.ok(texts.some((t) => t.endsWith('给卡牌加一个技能')));
  assert.ok(texts.includes('顺便加个测试'));
});

test('规则 path-missing：发错误卡，不调无头', async () => {
  let called = 0;
  const { manager, calls, spawned } = setup({
    configOverrides: { intakeEnabled: true },
    runIntake: async () => { called += 1; },
    fsApi: { existsSync: (p) => p !== 'Q:/nope', mkdirSync() {} },
  });
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: null, text: 'Q:/nope 干活' });
  assert.strictEqual(rec, null);
  assert.strictEqual(called, 0);
  assert.strictEqual(spawned.length, 0);
  const card = calls.find((c) => c[0] === 'sendCard')[2];
  assert.ok(JSON.stringify(card).includes('目录不存在'));
});

test('revive：spawn 抛错 → 返回 false、状态落成 error、不留半成品 PTY', async () => {
  // 第 0 次正常建会话，之后的重启一律失败
  const { manager, store, calls, rec } = await started({ spawnThrows: (i) => i > 0 });
  manager._sessions.clear();            // 模拟 daemon 重启：内存里的 PTY 全没了
  await manager.restoreAll();

  const ok = await manager.revive(store.get(rec.id));

  assert.strictEqual(ok, false);
  assert.strictEqual(store.get(rec.id).status, 'error');
  assert.strictEqual(manager._sessions.size, 0);
  const card = calls.filter((c) => c[0] === 'sendCard').at(-1)[2];
  assert.ok(JSON.stringify(card).includes('会话起不来'));
});

test('--resume 失败后的降级重建也失败：状态 error、提示重来、不留半成品', async () => {
  // 0=首次建会话，1=--resume 重开，2=降级重建 —— 让第 2 次失败
  const { manager, store, calls, spawned, rec } = await started({ spawnThrows: (i) => i === 2 });
  rec.claudeSessionId = 'cs_1';
  store.save();
  manager._sessions.clear();            // 模拟 daemon 重启：内存里的 PTY 全没了
  await manager.restoreAll();
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });

  spawned[1].emit({ type: 'exit', code: 1 });
  await manager._drain();

  assert.strictEqual(store.get(rec.id).status, 'error');
  assert.strictEqual(manager._sessions.size, 0);
  assert.ok(calls.some((c) => c[0] === 'sendText' && c[2].includes('重建会话失败')));
});

test('turn-end 带 guard:idle：处理中卡片就地收尾，不让它永远转圈', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].emit({ type: 'turn-start', seq: 1, origin: 'phone', text: '跑个测试' });
  await manager._drain();
  assert.ok(rec.pendingCard, '先有一张处理中卡片');

  spawned[0].emit({ type: 'turn-end', guard: 'idle' });
  await manager._drain();

  assert.strictEqual(rec.pendingCard, null);
  const upd = calls.filter((c) => c[0] === 'updateCardEntity').at(-1);
  assert.ok(JSON.stringify(upd).includes('没等到结束信号'));
});

test('Stop：中途从手机发的消息不会顶掉电脑那条提问', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].emit({ type: 'turn-start', seq: 1, origin: 'pc', text: '改下登录页' });
  spawned[0].emit({ type: 'pc-input', input: { seq: 1, origin: 'pc', text: '改下登录页', at: 1 } });
  // 手机又发了一条：input 事件在排队时就当场改写 lastInput
  spawned[0].emit({ type: 'input', input: { seq: 2, origin: 'phone', text: '顺便看日志', at: 2 } });

  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '改好了。' } });

  const card = calls.filter((c) => c[0] === 'sendCard').at(-1)[2];
  const body = JSON.stringify(card.body);
  assert.ok(body.includes('🖥 你刚在电脑上问：改下登录页'));
  assert.ok(!body.includes('顺便看日志'));
});

test('Stop：会话表落盘失败也不耽误定稿，不会再多发一张重复回复', async () => {
  const log = fakeLog();
  const { manager, store, calls, spawned, rec } = await started({ log });
  spawned[0].emit({ type: 'turn-start', seq: 1, origin: 'phone', text: '现在几点' });
  await manager._drain();
  assert.ok(rec.pendingCard, '先有一张处理中卡片');
  const sentBefore = calls.filter((c) => c[0] === 'sendCard').length;

  // 磁盘写不进去：只该留下一条 warn，不能把回复弄丢，也不能把它当成「定稿失败」再发一张
  store.save = () => { throw new Error('disk full'); };

  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '十点半。' } });

  const upd = calls.filter((c) => c[0] === 'updateCardEntity').at(-1);
  assert.ok(upd && JSON.stringify(upd).includes('十点半。'), '回复必须写进原来那张卡');
  assert.strictEqual(calls.filter((c) => c[0] === 'sendCard').length, sentBefore, '不能重复发一张卡');
  assert.ok(log.warns.some(([m]) => m === '落盘失败'));
});
