const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  trustKey, ensureTrusted, writeHookFile, prepareClaude, buildLaunch,
} = require('../src/agent/launcher');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fb-lnch-'));
}

test('trustKey 把反斜杠统一成正斜杠', () => {
  assert.strictEqual(trustKey('D:\\work\\alpha'), 'D:/work/alpha');
});

test('ensureTrusted 首次写入 true，再次调用 false，其他项目与顶层字段不受影响', () => {
  const dir = tmpDir();
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({
    projects: { 'D:/other': { hasTrustDialogAccepted: false, x: 1 } },
    numStartups: 7,
  }));
  assert.strictEqual(ensureTrusted({ claudeJsonPath: file, cwd: 'D:\\work\\alpha' }), true);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(doc.projects['D:/work/alpha'].hasTrustDialogAccepted, true);
  assert.strictEqual(doc.projects['D:/other'].hasTrustDialogAccepted, false);
  assert.strictEqual(doc.numStartups, 7);
  assert.strictEqual(ensureTrusted({ claudeJsonPath: file, cwd: 'D:/work/alpha' }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureTrusted 在 .claude.json 不存在时创建最小结构', () => {
  const dir = tmpDir();
  const file = path.join(dir, '.claude.json');
  assert.strictEqual(ensureTrusted({ claudeJsonPath: file, cwd: 'D:/a' }), true);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(doc.projects['D:/a'].hasTrustDialogAccepted, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeHookFile 生成 Stop 命令并带上 --session', () => {
  const dir = tmpDir();
  const file = writeHookFile({
    hooksDir: dir,
    sessionId: 's1',
    hookScript: 'D:\\feishu-bridge\\bin\\hook-stop.js',
  });
  assert.strictEqual(path.basename(file), 's1.hook.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const h = doc.hooks.Stop[0].hooks[0];
  assert.strictEqual(h.type, 'command');
  assert.ok(h.command.includes('hook-stop.js'));
  assert.ok(h.command.includes('--session s1'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prepareClaude：无 claudeSessionId 不带 --resume，有则带', () => {
  const dir = tmpDir();
  const config = { claudeExe: 'D:/Claude Code/claude.exe', claudeArgs: ['--permission-mode', 'bypassPermissions'] };
  const common = {
    config,
    hooksDir: path.join(dir, 'hooks'),
    hookScript: path.join(dir, 'hook-stop.js'),
    claudeJsonPath: path.join(dir, '.claude.json'),
  };

  const fresh = prepareClaude({
    session: { id: 's1', agent: 'claude', cwd: 'D:/w', claudeSessionId: null },
    ...common,
  });
  assert.strictEqual(fresh.file, config.claudeExe);
  assert.ok(fresh.args.includes('--settings'));
  assert.ok(!fresh.args.includes('--resume'));
  assert.deepStrictEqual(fresh.args.slice(-2), ['--permission-mode', 'bypassPermissions']);

  const resumed = prepareClaude({
    session: { id: 's2', agent: 'claude', cwd: 'D:/w', claudeSessionId: 'abc-123' },
    ...common,
  });
  assert.deepStrictEqual(resumed.args.slice(-2), ['--resume', 'abc-123']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildLaunch：codex 走 node + codex.js', () => {
  const config = {
    claudeExe: 'x',
    claudeArgs: [],
    codexEntry: 'C:/npm/codex.js',
    codexArgs: ['--dangerously-bypass-approvals-and-sandbox'],
  };
  const l = buildLaunch({ session: { agent: 'codex', cwd: 'D:/w' }, config });
  assert.strictEqual(l.file, process.execPath);
  assert.deepStrictEqual(l.args, ['C:/npm/codex.js', '--dangerously-bypass-approvals-and-sandbox']);
  assert.strictEqual(l.cwd, 'D:/w');
});
