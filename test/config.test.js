const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, saveConfig, DEFAULTS } = require('../src/config');

test('文件不存在时返回默认值副本，且不等于同一个对象', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-cfg-')), 'config.json');
  const a = loadConfig(file);
  const b = loadConfig(file);
  assert.strictEqual(a.defaultAgent, 'claude');
  assert.notStrictEqual(a, b);
});

test('部分字段覆盖默认值，其余保留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ appId: 'cli_1', queueLimit: 5 }));
  const c = loadConfig(file);
  assert.strictEqual(c.appId, 'cli_1');
  assert.strictEqual(c.queueLimit, 5);
  assert.deepStrictEqual(c.claudeArgs, DEFAULTS.claudeArgs);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveConfig 原子写，可被 loadConfig 读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-cfg-'));
  const file = path.join(dir, 'config.json');
  saveConfig(file, { appId: 'cli_2' });
  assert.strictEqual(loadConfig(file).appId, 'cli_2');
  assert.deepStrictEqual(fs.readdirSync(dir), ['config.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});
