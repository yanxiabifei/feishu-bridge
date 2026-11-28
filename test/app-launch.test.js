const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseLaunchArgs } = require('../app/lib/launchArgs');
const {
  RUN_KEY,
  VALUE_NAME,
  autostartCommand,
  isEnabled,
  setEnabled,
} = require('../app/lib/startup');
const { COOLDOWN_MS, resolveWindowCommand, createWindowLauncher } = require('../src/windowLaunch');

function makeLog() {
  const entries = [];
  const push = (level) => (event, data) => entries.push({ level, event, data });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

function fakeChild() {
  const child = { handlers: {}, unrefCalled: false };
  child.on = (event, fn) => { child.handlers[event] = fn; };
  child.unref = () => { child.unrefCalled = true; };
  return child;
}

// ---------- launchArgs ----------

test('launchArgs：--hidden 标记只进托盘', () => {
  assert.deepEqual(parseLaunchArgs(['electron.exe', 'D:\\fb', '--hidden']), { hidden: true, sessionId: null });
});

test('launchArgs：--session 与 --session= 两种写法都认', () => {
  assert.deepEqual(
    parseLaunchArgs(['fb.exe', '--session', 's-123']),
    { hidden: false, sessionId: 's-123' },
  );
  assert.deepEqual(
    parseLaunchArgs(['fb.exe', '--session=s-123']),
    { hidden: false, sessionId: 's-123' },
  );
  assert.deepEqual(
    parseLaunchArgs(['fb.exe', '--session=s-123', '--hidden']),
    { hidden: true, sessionId: 's-123' },
  );
});

test('launchArgs：脏参数不吞掉后面的开关', () => {
  const empty = { hidden: false, sessionId: null };
  assert.deepEqual(parseLaunchArgs(['fb.exe', '--session']), empty, '缺值');
  assert.deepEqual(parseLaunchArgs(['fb.exe', '--session', '--hidden']), { hidden: true, sessionId: null });
  assert.deepEqual(parseLaunchArgs(['fb.exe', '--session=']), empty);
  assert.deepEqual(parseLaunchArgs(['fb.exe', '--session', '--session=s2']), { hidden: false, sessionId: 's2' });
  assert.deepEqual(parseLaunchArgs([]), empty);
  assert.deepEqual(parseLaunchArgs(undefined), empty);
});

// ---------- startup（注册表，全部注入 exec，不真的写） ----------

test('startup：启动命令带引号与 --hidden', () => {
  assert.equal(autostartCommand('C:\\Program Files\\fb\\fb.exe'), '"C:\\Program Files\\fb\\fb.exe" --hidden');
});

test('startup：isEnabled 只看 reg query 是否成功', () => {
  const calls = [];
  assert.equal(isEnabled({ exec: (file, args) => { calls.push([file, args]); }, platform: 'win32' }), true);
  assert.equal(calls[0][0], 'reg.exe');
  assert.deepEqual(calls[0][1], ['query', RUN_KEY, '/v', VALUE_NAME]);

  assert.equal(isEnabled({ exec: () => { throw new Error('not found'); }, platform: 'win32' }), false);
});

test('startup：setEnabled(true) 写 Run 值并回查真实状态', () => {
  const calls = [];
  const enabled = setEnabled({
    exec: (file, args) => { calls.push([file, args]); },
    exePath: 'D:\\fb\\feishu-bridge.exe',
    enabled: true,
    platform: 'win32',
  });

  assert.equal(enabled, true);
  assert.equal(calls.length, 2, '写一次 + 回查一次');
  assert.deepEqual(calls[0][1], [
    'add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ',
    '/d', '"D:\\fb\\feishu-bridge.exe" --hidden', '/f',
  ]);
  assert.equal(calls[1][1][0], 'query');
});

test('startup：reg add 成功但回查不到时返回 false（杀软拦了就这样）', () => {
  let queried = false;
  const enabled = setEnabled({
    exec: (file, args) => {
      if (args[0] === 'query') { queried = true; throw new Error('not found'); }
    },
    exePath: 'D:\\fb\\fb.exe',
    enabled: true,
    platform: 'win32',
  });

  assert.equal(queried, true);
  assert.equal(enabled, false);
});

test('startup：setEnabled(false) 删值，本来没有也算成功', () => {
  const calls = [];
  const live = new Set(['old']);
  const enabled = setEnabled({
    exec: (file, args) => {
      calls.push([file, args]);
      if (args[0] === 'delete') { live.clear(); return; }
      if (args[0] === 'query' && live.size === 0) throw new Error('not found');
    },
    enabled: false,
    platform: 'win32',
  });

  assert.equal(enabled, false);
  assert.deepEqual(calls[0][1], ['delete', RUN_KEY, '/v', VALUE_NAME, '/f']);
});

test('startup：非 Windows 一律 false 且不调命令', () => {
  const calls = [];
  const exec = (file, args) => { calls.push([file, args]); };
  assert.equal(isEnabled({ exec, platform: 'linux' }), false);
  assert.equal(setEnabled({ exec, exePath: 'x', enabled: true, platform: 'darwin' }), false);
  assert.equal(calls.length, 0);
});

test('startup：开启时没有 exe 路径就什么都不做', () => {
  const calls = [];
  assert.equal(setEnabled({ exec: (f, a) => { calls.push([f, a]); }, enabled: true, platform: 'win32' }), false);
  assert.equal(calls.length, 0);
});

// ---------- windowLaunch ----------

const ROOT = 'D:\\feishu-bridge';
const DEV_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

test('windowLaunch：优先用配置里的 windowExe，其次是开发模式的 electron', () => {
  const existsAll = () => true;
  assert.deepEqual(
    resolveWindowCommand({ config: { windowExe: 'D:\\fb\\fb.exe' }, root: ROOT, existsSync: existsAll }),
    { command: 'D:\\fb\\fb.exe', args: [] },
  );
  assert.deepEqual(
    resolveWindowCommand({ config: { windowExe: 'D:\\gone\\fb.exe' }, root: ROOT, existsSync: (p) => p === DEV_EXE }),
    { command: DEV_EXE, args: [ROOT] },
  );
  assert.equal(resolveWindowCommand({ config: {}, root: ROOT, existsSync: () => false }), null);
  assert.equal(resolveWindowCommand({ config: { windowExe: '   ' }, root: '', existsSync: existsAll }), null);
});

test('windowLaunch：窗口在线时不拉进程（在线的那条路径是 IPC 广播）', () => {
  const log = makeLog();
  const calls = [];
  const launcher = createWindowLauncher({
    config: { windowExe: 'D:\\fb\\fb.exe' },
    log,
    spawn: (...args) => { calls.push(args); return fakeChild(); },
    existsSync: () => true,
  });

  assert.deepEqual(launcher.launch('s1', 1), { launched: false, reason: 'online' });
  assert.equal(calls.length, 0);
  assert.equal(log.entries.length, 0);
});

test('windowLaunch：开关关掉就退回纯按需', () => {
  const log = makeLog();
  const launcher = createWindowLauncher({
    config: { windowExe: 'D:\\fb\\fb.exe', windowAutoLaunch: false },
    log,
    spawn: () => { throw new Error('不该被调用'); },
    existsSync: () => true,
  });

  assert.deepEqual(launcher.launch('s1', 0), { launched: false, reason: 'disabled' });
  assert.equal(log.entries[0].event, 'window.launch_skipped');
  assert.equal(log.entries[0].data.reason, 'disabled');
});

test('windowLaunch：找不到 exe 只记 warn，不影响会话创建', () => {
  const log = makeLog();
  const launcher = createWindowLauncher({
    config: {},
    root: ROOT,
    log,
    spawn: () => { throw new Error('不该被调用'); },
    existsSync: () => false,
  });

  assert.deepEqual(launcher.launch('s1', 0), { launched: false, reason: 'no_exe' });
  assert.equal(log.entries[0].level, 'warn');
  assert.equal(log.entries[0].data.reason, 'no_exe');
});

test('windowLaunch：拉起时带上 --session 并 unref，命令按 exe 直接调', () => {
  const log = makeLog();
  const calls = [];
  const child = fakeChild();
  const launcher = createWindowLauncher({
    config: { windowExe: 'D:\\fb\\fb.exe' },
    log,
    spawn: (...args) => { calls.push(args); return child; },
    existsSync: () => true,
  });

  assert.deepEqual(launcher.launch('s-42', 0), { launched: true, reason: 'spawned' });
  assert.deepEqual(calls[0], [
    'D:\\fb\\fb.exe',
    ['--session', 's-42'],
    { detached: true, stdio: 'ignore' },
  ]);
  assert.equal(child.unrefCalled, true);
  assert.equal(typeof child.handlers.error, 'function', '子进程错误必须被接住');
  assert.doesNotThrow(() => child.handlers.error(new Error('ENOENT')));
  assert.equal(log.entries.at(-1).event, 'window.launch_failed');
});

test('windowLaunch：30 秒冷却期内的后续会话不再刷 spawn', () => {
  const log = makeLog();
  let t = 1000;
  const calls = [];
  const launcher = createWindowLauncher({
    config: { windowExe: 'D:\\fb\\fb.exe' },
    log,
    spawn: (...args) => { calls.push(args); return fakeChild(); },
    existsSync: () => true,
    now: () => t,
  });

  assert.equal(launcher.launch('s1', 0).launched, true);
  t += COOLDOWN_MS - 1;
  assert.deepEqual(launcher.launch('s2', 0), { launched: false, reason: 'cooldown' });
  t += 1;
  assert.equal(launcher.launch('s3', 0).launched, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][1], ['--session', 's3']);
});

test('windowLaunch：spawn 同步抛错时记 launch_failed 并返回 false', () => {
  const log = makeLog();
  const launcher = createWindowLauncher({
    config: { windowExe: 'D:\\fb\\fb.exe' },
    log,
    spawn: () => { throw new Error('EACCES'); },
    existsSync: () => true,
  });

  assert.deepEqual(launcher.launch('s1', 0), { launched: false, reason: 'error' });
  assert.equal(log.entries[0].event, 'window.launch_failed');
  assert.match(log.entries[0].data.error, /EACCES/);
});

test('windowLaunch：没有 sessionId 直接返回，不碰 spawn', () => {
  const launcher = createWindowLauncher({
    config: { windowExe: 'D:\\fb\\fb.exe' },
    log: makeLog(),
    spawn: () => { throw new Error('不该被调用'); },
    existsSync: () => true,
  });
  assert.deepEqual(launcher.launch('', 0), { launched: false, reason: 'no_session' });
});
