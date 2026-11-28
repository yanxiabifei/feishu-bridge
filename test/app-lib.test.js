const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readEndpoint, buildWsUrl } = require('../app/lib/endpoint');
const { buildPicker } = require('../app/lib/pickerModel');
const { createSessionFeed } = require('../app/lib/sessionFeed');
const { formatTitle, formatSyncLine } = require('../app/lib/format');

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
    projects: { aliases: { 'D:/card': '卡牌' }, default: 'D:/w' },
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

test('format：窗口标题与底部状态栏', () => {
  const at = new Date('2026-11-23T21:40:00').getTime();
  assert.strictEqual(formatTitle({ alias: '卡牌', cwd: 'D:/x', createdAt: at }), '卡牌 · 11-23 21:40');
  assert.strictEqual(formatTitle({ cwd: 'D:/x/blog' }), 'blog');
  assert.strictEqual(formatSyncLine({ session: { alias: '卡牌' }, at }), '已同步 · 卡牌 · 11-23 21:40');
  assert.strictEqual(formatSyncLine({ session: { alias: '卡牌' }, state: 'reconnecting', at }), '重连中 · 卡牌 · 11-23 21:40');
});
