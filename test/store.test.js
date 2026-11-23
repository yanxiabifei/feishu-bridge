const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, writeJsonAtomic } = require('../src/store');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'sessions.json');
}

test('upsert 后可重新加载，按 id 与 chatId 都能查到', () => {
  const file = tmpFile();
  const s = createStore({ file }).load();
  s.upsert({ id: 's1', chatId: 'oc_1', status: 'idle' });
  const again = createStore({ file }).load();
  assert.strictEqual(again.get('s1').status, 'idle');
  assert.strictEqual(again.getByChat('oc_1').id, 's1');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('remove 会落盘', () => {
  const file = tmpFile();
  const s = createStore({ file }).load();
  s.upsert({ id: 's1', chatId: 'oc_1' });
  s.remove('s1');
  assert.strictEqual(createStore({ file }).load().get('s1'), null);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('文件损坏时改名备份并从空表开始，不抛异常', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ 这不是 JSON');
  const warnings = [];
  const s = createStore({ file, log: { warn: (e) => warnings.push(e) } }).load();
  assert.deepStrictEqual(s.all(), []);
  assert.strictEqual(warnings[0], 'store.corrupt');
  assert.ok(fs.readdirSync(path.dirname(file)).some((n) => n.startsWith('sessions.json.corrupt-')));
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('writeJsonAtomic 不留 .tmp', () => {
  const file = tmpFile();
  writeJsonAtomic(file, { sessions: [] });
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['sessions.json']);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
