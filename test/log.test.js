const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { redact, createRedactor, createLogger } = require('../src/log');

test('redact 按键名屏蔽敏感字段，非敏感字段原样保留', () => {
  const out = redact({
    app_secret: 'abc',
    appId: 'cli_1',
    nested: { ANTHROPIC_AUTH_TOKEN: 'sk-x' },
    chatId: 'oc_1',
  });
  assert.deepStrictEqual(out, {
    app_secret: '***',
    appId: 'cli_1',
    nested: { ANTHROPIC_AUTH_TOKEN: '***' },
    chatId: 'oc_1',
  });
});

test('createRedactor 在任意字符串里替换已登记的字面量', () => {
  const r = createRedactor();
  r.add('sk-abc-123456');
  assert.strictEqual(r.scrub('token=sk-abc-123456 ok'), 'token=*** ok');
  assert.strictEqual(r.scrub('nothing here'), 'nothing here');
});

test('createLogger 写 JSONL，一行一条，且不含密钥字面量', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-log-'));
  const log = createLogger({ dir, now: () => new Date('2026-11-23T13:00:00Z') });
  log.redactor.add('SECRET-VALUE-1');
  log.info('boot', { appId: 'cli_1', note: 'key=SECRET-VALUE-1' });
  log.warn('slow', { ms: 30 });

  const file = path.join(dir, '2026-11-23.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].event, 'boot');
  assert.strictEqual(lines[0].note, 'key=***');
  assert.strictEqual(lines[1].level, 'warn');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('createLogger 将 Error 序列化为可读字段并按字面量脱敏', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-log-'));
  const log = createLogger({ dir, now: () => new Date('2026-11-23T13:00:00Z') });
  log.redactor.add('boom-internal');
  log.error('explode', { err: new Error('boom-internal') });

  const file = path.join(dir, '2026-11-23.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(lines[0].err.name, 'Error');
  assert.strictEqual(lines[0].err.message, '***');
  assert.match(lines[0].err.stack, /\*\*\*/);
  assert.strictEqual(redact(new Error('boom-internal')).message, 'boom-internal');

  fs.rmSync(dir, { recursive: true, force: true });
});
