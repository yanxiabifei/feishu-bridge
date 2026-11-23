const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, saveConfig, DEFAULTS } = require('../src/config');

test('文件不存在时返回默认值副本，且不等于同一个对象', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const a = loadConfig(file);
  const b = loadConfig(file);
  assert.strictEqual(a.defaultAgent, 'claude');
  assert.notStrictEqual(a, b);
});

test('部分字段覆盖默认值，其余保留', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ appId: 'cli_1', queueLimit: 5 }));
  const c = loadConfig(file);
  assert.strictEqual(c.appId, 'cli_1');
  assert.strictEqual(c.queueLimit, 5);
  assert.deepStrictEqual(c.claudeArgs, DEFAULTS.claudeArgs);
  assert.notStrictEqual(c.claudeArgs, DEFAULTS.claudeArgs);
  assert.notStrictEqual(c.codexArgs, DEFAULTS.codexArgs);
});

test('两次 loadConfig 的数组互不共享，也不污染 DEFAULTS', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const a = loadConfig(file);
  const b = loadConfig(file);
  const defaultsLen = DEFAULTS.claudeArgs.length;
  a.claudeArgs.push('--extra');
  assert.notStrictEqual(a.claudeArgs, b.claudeArgs);
  assert.strictEqual(DEFAULTS.claudeArgs.length, defaultsLen);
  assert.deepStrictEqual(b.claudeArgs, DEFAULTS.claudeArgs);
});

test('saveConfig 原子写，可被 loadConfig 读回', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  saveConfig(file, { appId: 'cli_2' });
  assert.strictEqual(loadConfig(file).appId, 'cli_2');
  assert.deepStrictEqual(fs.readdirSync(dir), ['config.json']);
});
