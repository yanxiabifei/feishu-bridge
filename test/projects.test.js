const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProjects } = require('../src/projects');

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
