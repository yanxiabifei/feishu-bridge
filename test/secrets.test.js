const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSecretStore } = require('../src/secrets');

test('DPAPI 模式下 roundtrip 正常，文件里没有明文', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-sec-'));
  const file = path.join(dir, 'secret.bin');
  const fakeRunner = (script, inputB64) => inputB64; // 假装加密=原样
  const store = createSecretStore({ file, runner: fakeRunner, acl: () => {} });
  assert.strictEqual(store.save('ap-secret-123'), 'dpapi');
  assert.strictEqual(store.load(), 'ap-secret-123');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('ap-secret-123'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('加密失败时降级为明文模式并调用 ACL 收紧，仍可读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-sec-'));
  const file = path.join(dir, 'secret.bin');
  let aclCalled = 0;
  const store = createSecretStore({
    file,
    runner: () => { throw new Error('powershell disabled'); },
    acl: () => { aclCalled += 1; },
    log: { warn() {} },
  });
  assert.strictEqual(store.save('ap-secret-456'), 'plain');
  assert.strictEqual(aclCalled, 1);
  assert.strictEqual(store.load(), 'ap-secret-456');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('明文模式 ACL 把文件设成只读后再保存，自动放开权限重写成功', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-sec-'));
  const file = path.join(dir, 'secret.bin');
  const store = createSecretStore({
    file,
    runner: () => { throw new Error('powershell disabled'); },
    acl: (f) => fs.chmodSync(f, 0o444), // 模拟 icacls /grant:r:USER:R
    log: { warn() {} },
  });
  assert.strictEqual(store.save('first-secret'), 'plain');
  assert.strictEqual(store.save('second-secret'), 'plain');
  assert.strictEqual(store.load(), 'second-secret');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('凭据文件损坏时报中文错误并提示重新 setup，而不是抛原始 SyntaxError', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-sec-'));
  const file = path.join(dir, 'secret.bin');
  fs.writeFileSync(file, '{not json');
  const store = createSecretStore({ file, runner: (s, i) => i, acl: () => {} });
  assert.throws(() => store.load(), /凭据文件损坏.*npm run setup/s);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DPAPI 解密失败时报中文错误并提示重新 setup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-sec-'));
  const file = path.join(dir, 'secret.bin');
  fs.writeFileSync(file, JSON.stringify({ mode: 'dpapi', data: 'AAAA' }));
  const store = createSecretStore({
    file,
    runner: () => { throw new Error('CryptographicException'); },
    acl: () => {},
  });
  assert.throws(() => store.load(), /解密失败.*npm run setup/s);
  fs.rmSync(dir, { recursive: true, force: true });
});
