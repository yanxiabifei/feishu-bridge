const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProjects, renameAlias } = require('../src/projects');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proj-'));
}

test('文件不存在时返回空别名与传入的默认目录', () => {
  const r = loadProjects({ file: path.join(tmpDir(), 'none.json'), defaultCwd: 'D:/w' });
  assert.deepStrictEqual(r, { aliases: {}, default: 'D:/w' });
});

test('读取 aliases 与 default，过滤非字符串和空白值', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'projects.json');
  fs.writeFileSync(file, JSON.stringify({
    aliases: { 卡牌: 'D:/card', 坏: 42, 空: '   ' },
    default: 'D:/workspace',
  }));
  assert.deepStrictEqual(loadProjects({ file, defaultCwd: 'D:/w' }), {
    aliases: { 卡牌: 'D:/card' },
    default: 'D:/workspace',
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('JSON 损坏时不抛错，退回默认值', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'projects.json');
  fs.writeFileSync(file, '{ 这不是 json');
  assert.deepStrictEqual(loadProjects({ file, defaultCwd: 'D:/w' }), { aliases: {}, default: 'D:/w' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('文件里没有 default 时用传入的 defaultCwd', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'projects.json');
  fs.writeFileSync(file, JSON.stringify({ aliases: {} }));
  assert.strictEqual(loadProjects({ file, defaultCwd: 'D:/w' }).default, 'D:/w');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renameAlias：改别名，保留 default 与 recent', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'projects.json');
  fs.writeFileSync(file, JSON.stringify({
    aliases: { 卡牌: 'D:/card', 桥: 'D:/feishu-bridge' },
    default: 'D:/w',
    recent: [{ path: 'D:/x' }],
  }));

  const r = renameAlias({ file, from: '卡牌', to: '卡牌2' });
  assert.strictEqual(r.ok, true);

  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(doc.aliases, { 卡牌2: 'D:/card', 桥: 'D:/feishu-bridge' });
  assert.strictEqual(doc.default, 'D:/w');
  assert.deepStrictEqual(doc.recent, [{ path: 'D:/x' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renameAlias：不存在 / 重名 / 带空格都拒绝且不改文件', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'projects.json');
  const original = JSON.stringify({ aliases: { 卡牌: 'D:/card', 桥: 'D:/b' } });
  fs.writeFileSync(file, original);

  assert.strictEqual(renameAlias({ file, from: '没有', to: 'x' }).ok, false);
  assert.strictEqual(renameAlias({ file, from: '卡牌', to: '桥' }).ok, false);
  assert.strictEqual(renameAlias({ file, from: '卡牌', to: '新 名' }).ok, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renameAlias：新别名是 __proto__ 也不会丢数据', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'projects.json');
  fs.writeFileSync(file, JSON.stringify({ aliases: { 卡牌: 'D:/card' } }));

  const r = renameAlias({ file, from: '卡牌', to: '__proto__' });
  assert.strictEqual(r.ok, true);

  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(Object.keys(doc.aliases), ['__proto__']);
  assert.strictEqual(Object.getOwnPropertyDescriptor(doc.aliases, '__proto__').value, 'D:/card');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renameAlias：新别名超过 20 个字符就拒绝，20 个字符正好放行', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'projects.json');
  const original = JSON.stringify({ aliases: { 卡牌: 'D:/card' } });
  fs.writeFileSync(file, original);

  const long = renameAlias({ file, from: '卡牌', to: 'x'.repeat(21) });
  assert.strictEqual(long.ok, false);
  assert.match(long.message, /最多 20/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), original);

  const edge = renameAlias({ file, from: '卡牌', to: 'y'.repeat(20) });
  assert.strictEqual(edge.ok, true);
  assert.deepStrictEqual(Object.keys(edge.aliases), ['y'.repeat(20)]);
  fs.rmSync(dir, { recursive: true, force: true });
});
