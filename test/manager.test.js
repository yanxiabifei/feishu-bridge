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
  apiOverrides, fsApi, getProjects, now, projects, spawnThrows = false, ipc: ipcArg = null, configOverrides,
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
        if (spawnThrows) throw new Error('pty 启动失败');
        ps.started = true;
      },
      submitText(text, origin, opts) {
        const item = { text, origin };
        if (opts && opts.force) item.force = true;
        ps.submitted.push(item);
        return ps.pushResult || 'queued';
      },
      onPcKeys() {},
      needsConfirm() { return ps.confirm; },
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
  const manager = createManager({
    config: {
      defaultCwd: 'D:/w',
      ownerOpenId: 'ou_me',
      queueLimit: 20,
      autoDisband: false,
      ...configOverrides,
    },
    api,
    store,
    log: { info() {}, warn() {}, error() {} },
    createPtySession,
    ipc,
    mediaRoot: 'D:/media',
    now: now || (() => new Date(2026, 10, 23, 21, 40).getTime()),
    rand: () => 0,
    fsApi: fsApi || { existsSync: () => true, mkdirSync() {} },
    getProjects: getProjects || (() => ({ ...(projects || { aliases: { 卡牌: 'D:/card' }, default: 'D:/w' }) })),
  });
  return {
    manager, store, calls, spawned, broadcasts,
  };
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

test('onPhoneMessage：会话已停 → 提示「重来」，不写入', async () => {
  const { manager, spawned, calls } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  spawned[0].emit({ type: 'exit', code: 1 });
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '还在吗', senderOpenId: 'ou_me' });
  assert.strictEqual(spawned[0].submitted.length, 0);
  assert.ok(calls.some((c) => c[0] === 'sendText' && /重来/.test(c[2])));
});

test('onPhoneMessage：普通消息会清掉待确认的旧文本，「仍然发送」不会复活它', async () => {
  const { manager, spawned } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });

  // 先被护栏拦下，暂存「继续」
  spawned[0].confirm = true;
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });
  assert.strictEqual(spawned[0].submitted.length, 0);

  // 护栏解除后发一条普通消息：应正常入队，并清掉暂存
  spawned[0].confirm = false;
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '先做别的', senderOpenId: 'ou_me' });

  // 再发「仍然发送」：此时没有待确认文本，不能被当成强写指令把「继续」塞进去
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '仍然发送', senderOpenId: 'ou_me' });

  const texts = spawned[0].submitted.map((s) => s.text);
  assert.deepStrictEqual(texts, ['先做别的', '仍然发送']);
  assert.ok(!spawned[0].submitted.some((s) => s.force === true));
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
  spawned[0].emit({ type: 'input', input: { seq: 2, origin: 'phone', text: '   ', at: 2 } });
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
  await manager.restoreAll();

  await manager.onPhoneMessage({ chatId: 'oc_1', text: '接着干', senderOpenId: 'ou_me' });

  assert.strictEqual(spawned.length, 2);
  assert.deepStrictEqual(spawned[1].submitted.at(-1), { text: '接着干', origin: 'phone' });
});

test('interrupted + claudeSessionId：重开带着它（--resume 由 launcher 加）', async () => {
  const { manager, store, spawned, rec } = await started();
  rec.claudeSessionId = 'cs_1';
  store.save();
  await manager.restoreAll();

  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });

  assert.strictEqual(spawned[1].session.claudeSessionId, 'cs_1');
  assert.strictEqual(spawned[1].session.resuming, true);
});

test('--resume 失败：清掉旧会话 ID，改用新会话重建', async () => {
  const { manager, store, calls, spawned, rec } = await started();
  rec.claudeSessionId = 'cs_1';
  store.save();
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
  await manager.restoreAll();

  await manager.onPhoneMessage({ chatId: 'oc_1', text: '重来', senderOpenId: 'ou_me' });

  assert.strictEqual(spawned.length, 2);
  assert.strictEqual(spawned[1].submitted.length, 0);
});
