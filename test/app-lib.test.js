const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readEndpoint, buildWsUrl } = require('../app/lib/endpoint');
const { locateEndpointFile, listCandidates, locateStateDir } = require('../app/lib/endpointFile');
const { buildPicker } = require('../app/lib/pickerModel');
const { closeChoices } = require('../app/lib/closePrompt');
const { createSessionFeed } = require('../app/lib/sessionFeed');
const { formatTitle, formatSyncLine, mmddhhmm } = require('../app/lib/format');
const { pickErrorTarget } = require('../app/lib/errorRoute');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-app-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('endpoint：读取 ipc.json，ipc.json 缺失时提示先启动守护进程', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'ipc.json');
  assert.throws(() => readEndpoint({ file }), /npm start/);

  fs.writeFileSync(file, JSON.stringify({ port: 47831, token: 'tok', pid: 12 }));
  assert.deepStrictEqual(readEndpoint({ file }), { port: 47831, token: 'tok', pid: 12 });
  assert.strictEqual(buildWsUrl({ port: 47831, token: 'a b' }), 'ws://127.0.0.1:47831/?token=a%20b');
});

test('endpoint：带 BOM 或坏内容时给出可操作的错误', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'ipc.json');
  fs.writeFileSync(file, '﻿' + JSON.stringify({ port: 1, token: 't' }));
  assert.strictEqual(readEndpoint({ file }).port, 1);

  fs.writeFileSync(file, '{oops');
  assert.throws(() => readEndpoint({ file }), /已损坏/);

  fs.writeFileSync(file, JSON.stringify({ port: 0, token: '' }));
  assert.throws(() => readEndpoint({ file }), /内容不完整/);
});

test('picker：近期目录按最后活动排序，别名表优先，默认目录单独给出', () => {
  const out = buildPicker({
    // projects.json 的别名方向是「别名 → 目录」，和 router 的扫描一致
    projects: { aliases: { 卡牌: 'D:/card' }, default: 'D:/w' },
    sessions: [
      { id: 'a', cwd: 'D:/card', agent: 'claude', createdAt: 10 },
      { id: 'b', cwd: 'D:/blog', agent: 'codex', createdAt: 30 },
      { id: 'c', cwd: 'D:/blog', agent: 'codex', createdAt: 20 },
    ],
  });
  assert.deepStrictEqual(out.recent.map((r) => r.cwd), ['D:/blog', 'D:/card']);
  assert.strictEqual(out.recent[1].alias, '卡牌');
  assert.strictEqual(out.recent[0].alias, 'blog');
  assert.strictEqual(out.defaultCwd, 'D:/w');
  assert.deepStrictEqual(out.agents, ['claude', 'codex']);
});

test('picker：会话记录里的 ISO 时间字符串也能正确排序', () => {
  const out = buildPicker({
    projects: {},
    sessions: [
      { id: 'a', cwd: 'D:/old', agent: 'claude', createdAt: '2026-11-20T10:00:00.000Z' },
      { id: 'b', cwd: 'D:/new', agent: 'codex', createdAt: '2026-11-22T10:00:00.000Z' },
      {
        id: 'c',
        cwd: 'D:/mid',
        agent: 'claude',
        createdAt: '2026-11-01T10:00:00.000Z',
        lastActiveAt: '2026-11-21T10:00:00.000Z',
      },
    ],
  });
  assert.deepStrictEqual(out.recent.map((r) => r.cwd), ['D:/new', 'D:/mid', 'D:/old']);
});

test('closePrompt：正忙时默认取消，空闲时默认结束；取消永远是 Esc', () => {
  assert.deepStrictEqual(closeChoices('running').buttons.map((b) => b.id), ['cancel', 'detach', 'close']);
  assert.strictEqual(closeChoices('starting').defaultId, 'cancel');
  assert.strictEqual(closeChoices('running').cancelId, 'cancel');

  const idle = closeChoices('idle');
  assert.deepStrictEqual(idle.buttons.map((b) => b.id), ['close', 'detach', 'cancel']);
  assert.strictEqual(idle.defaultId, 'close');
  assert.strictEqual(idle.cancelId, 'cancel');
  assert.strictEqual(idle.buttons.find((b) => b.id === 'close').label, '结束会话');
});

test('picker：可接回的会话只留未结束的，按最后活动倒序并带状态', () => {
  const out = buildPicker({
    projects: {},
    sessions: [
      { id: 'a', cwd: 'D:/a', alias: '旧', agent: 'claude', status: 'closed', createdAt: 50 },
      { id: 'b', cwd: 'D:/b', alias: '跑着', agent: 'claude', status: 'running', createdAt: 10, lastActiveAt: 40 },
      { id: 'c', cwd: 'D:/c', alias: '空闲', agent: 'codex', status: 'idle', createdAt: 20 },
      { id: 'd', cwd: 'D:/d', status: 'error', createdAt: 30 },
    ],
  });
  assert.deepStrictEqual(out.resumable.map((s) => s.id), ['b', 'd', 'c']);
  assert.strictEqual(out.resumable[0].status, 'running');
  assert.strictEqual(out.resumable[1].alias, 'd'); // 没别名时用目录名兜底
});

test('sessionFeed：replay 到达前的实时输出被丢弃，之后才写入', () => {
  const feed = createSessionFeed();
  assert.deepStrictEqual(feed.select('s1'), { type: 'attach', sessionId: 's1' });

  assert.deepStrictEqual(feed.handle({ type: 'data', sessionId: 's1', data: '早期输出' }), []);
  const effects = feed.handle({ type: 'replay', sessionId: 's1', data: '整屏快照' });
  assert.deepStrictEqual(effects, [{ type: 'reset' }, { type: 'write', data: '整屏快照' }]);
  assert.deepStrictEqual(feed.handle({ type: 'data', sessionId: 's1', data: '后续' }), [{ type: 'write', data: '后续' }]);

  // 别的会话的输出永远不进当前窗口
  assert.deepStrictEqual(feed.handle({ type: 'data', sessionId: 's2', data: 'x' }), []);
});

test('sessionFeed：session 推来后更新列表与当前会话，错误转成可展示的副作用', () => {
  const feed = createSessionFeed();
  feed.select('s1');
  feed.handle({ type: 'sessions', list: [{ id: 's1', status: 'idle' }] });
  feed.handle({ type: 'session', session: { id: 's1', status: 'running', alias: '卡牌' } });
  const st = feed.getState();
  assert.strictEqual(st.sessions.length, 1);
  assert.strictEqual(st.selected.status, 'running');
  assert.strictEqual(st.selected.alias, '卡牌');

  assert.deepStrictEqual(feed.handle({ type: 'error', message: '会话不存在' }), [
    { type: 'error', message: '会话不存在' },
  ]);
});

test('sessionFeed：切换会话后不再挂着上一个会话的详情', () => {
  const feed = createSessionFeed();
  feed.select('s1');
  feed.handle({ type: 'sessions', list: [{ id: 's1', alias: '旧' }, { id: 's2', alias: '新' }] });
  feed.handle({ type: 'session', session: { id: 's1', alias: '旧' } });
  assert.strictEqual(feed.getState().selected.alias, '旧');

  feed.select('s2');
  assert.strictEqual(feed.getState().selectedId, 's2');
  assert.strictEqual(feed.getState().selected.id, 's2');
  assert.strictEqual(feed.getState().selected.alias, '新');
});

test('endpointFile：优先环境变量，其次 cwd/state，再沿 exe 与 app 目录向上找', (t) => {
  const root = tmpDir(t);
  const cwd = path.join(root, 'work');
  const bin = path.join(root, 'dist', 'app', 'resources', 'app');
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const stateFile = path.join(root, 'state', 'ipc.json');
  fs.writeFileSync(stateFile, '{}');

  const cands = listCandidates({ env: {}, cwd, execPath: path.join(root, 'dist', 'exe', 'a.exe'), appPath: bin });
  assert.deepStrictEqual(cands.slice(0, 2), [
    path.join(cwd, 'state', 'ipc.json'),
    path.join(root, 'dist', 'exe', 'state', 'ipc.json'),
  ]);
  // cwd 下没有就往上找；app 目录向上 4 层正好是仓库根
  assert.strictEqual(locateEndpointFile({ env: {}, cwd, execPath: path.join(root, 'dist', 'exe', 'a.exe'), appPath: bin, fsApi: fs }), stateFile);

  const custom = path.join(root, 'custom.json');
  fs.writeFileSync(custom, '{}');
  assert.strictEqual(
    locateEndpointFile({ env: { FEISHU_BRIDGE_IPC: custom }, cwd, execPath: bin, appPath: bin, fsApi: fs }),
    custom,
  );
});

test('endpointFile：都不存在时返回第一个候选，交给 readEndpoint 报「先运行 npm start」', (t) => {
  const root = tmpDir(t);
  const first = path.join(root, 'state', 'ipc.json');
  assert.strictEqual(
    locateEndpointFile({ env: {}, cwd: root, execPath: path.join(root, 'a.exe'), appPath: root, fsApi: fs }),
    first,
  );
});

test('endpointFile：locateStateDir 取第一个存在的 state 目录，不看 ipc.json 在不在', (t) => {
  const root = tmpDir(t);
  const cwd = path.join(root, 'work');
  // 开机自启时 ipc.json 可能还没写出来，但 state 目录已经建好了
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  assert.strictEqual(
    locateStateDir({ env: {}, cwd, execPath: path.join(root, 'dist', 'exe', 'a.exe'), appPath: root, fsApi: fs }),
    path.join(root, 'state'),
  );
});

test('endpointFile：locateStateDir 一个都没有时退回 cwd/state', (t) => {
  const root = tmpDir(t);
  assert.strictEqual(
    locateStateDir({ env: {}, cwd: root, execPath: path.join(root, 'a.exe'), appPath: root, fsApi: fs }),
    path.join(root, 'state'),
  );
});

test('format：窗口标题与底部状态栏', () => {
  const at = new Date('2026-11-23T21:40:00').getTime();
  assert.strictEqual(formatTitle({ alias: '卡牌', cwd: 'D:/x', createdAt: at }), '卡牌 · 11-23 21:40');
  assert.strictEqual(formatTitle({ cwd: 'D:/x/blog' }), 'blog');
  assert.strictEqual(formatSyncLine({ session: { alias: '卡牌' }, at }), '已同步 · 卡牌 · 11-23 21:40');
  assert.strictEqual(formatSyncLine({ session: { alias: '卡牌' }, state: 'reconnecting', at }), '重连中 · 卡牌 · 11-23 21:40');
});

test('format：会话记录里的 ISO 时间字符串也能进标题与状态栏', () => {
  const iso = '2026-11-23T21:40:00';
  assert.strictEqual(formatTitle({ alias: '卡牌', createdAt: iso }), '卡牌 · 11-23 21:40');
  assert.strictEqual(formatSyncLine({ session: { alias: '卡牌' }, at: iso }), '已同步 · 卡牌 · 11-23 21:40');
  assert.strictEqual(mmddhhmm('不是时间'), '');
  assert.strictEqual(mmddhhmm(0), '');
});

test('errorRoute：按 sessionId 认领，多窗口之间不串错误', () => {
  const a = { kind: 'session', sessionId: 's1', awaiting: 'attach' };
  const b = { kind: 'session', sessionId: 's2', awaiting: 'restart' };
  assert.strictEqual(pickErrorTarget([a, b], { sessionId: 's1', replyTo: 'attach' }), a);
  assert.strictEqual(pickErrorTarget([a, b], { sessionId: 's2', replyTo: 'restart' }), b);
});

test('errorRoute：只带 sessionId 的回包也认同一个会话', () => {
  const a = { kind: 'session', sessionId: 's1', awaiting: 'attach' };
  const b = { kind: 'session', sessionId: 's2', awaiting: 'attach' };
  assert.strictEqual(pickErrorTarget([a, b], { sessionId: 's2' }), b);
});

test('errorRoute：没有 sessionId 的老回包按请求类型认领，认不出交给调用方广播', () => {
  const picker = { kind: 'picker', awaiting: 'create' };
  const win = { kind: 'session', sessionId: 's1', awaiting: 'attach' };
  assert.strictEqual(pickErrorTarget([picker, win], { replyTo: 'create' }), picker);
  assert.strictEqual(pickErrorTarget([picker, win], {}), null);
  assert.strictEqual(pickErrorTarget([], { sessionId: 's1' }), null);
  assert.strictEqual(pickErrorTarget(undefined, { replyTo: 'attach' }), null);
});

test('errorRoute：sessionId 对不上但类型对得上，仍按类型认领', () => {
  const win = { kind: 'session', sessionId: 's1', awaiting: 'restart' };
  assert.strictEqual(pickErrorTarget([win], { sessionId: 'other', replyTo: 'restart' }), win);
});
