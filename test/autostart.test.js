const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  TASK,
  buildCmd,
  buildVbs,
  buildXml,
  currentSid,
  taskExists,
  install,
  uninstall,
  status,
  main,
} = require('../scripts/autostart');

const CMD_NAME = 'daemon-autostart.cmd';
const VBS_NAME = 'daemon-autostart.vbs';
const XML_NAME = 'daemon-autostart.xml';

// 临时目录固定放 D:\tmp（纯 ASCII）：install 会拒绝含中文/非 ASCII 的路径，
// 而系统 TEMP 常常落在带中文的用户目录下。
function tmpdir(t) {
  const base = 'D:\\tmp';
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'fb-autostart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeRun(calls, impl) {
  return (file, args) => {
    calls.push([file, args]);
    if (impl) return impl(file, args);
    return '';
  };
}

// 真实 schtasks /Query /FO CSV /NH 的根任务首字段带前导反斜杠。
function taskLine(name = TASK) {
  return `"\\${name}","N/A","就绪"`;
}

function writeScripts(dir) {
  for (const name of [CMD_NAME, VBS_NAME, XML_NAME]) {
    fs.writeFileSync(path.join(dir, name), 'x');
  }
}

function runMain(argv, options) {
  const prevCode = process.exitCode;
  const prevError = console.error;
  const prevLog = console.log;
  let stderr = '';
  let stdout = '';
  console.error = (...args) => { stderr += args.join(' ') + '\n'; };
  console.log = (...args) => { stdout += args.join(' ') + '\n'; };
  try {
    main(argv, options);
    return { code: process.exitCode, stderr, stdout };
  } finally {
    console.error = prevError;
    console.log = prevLog;
    process.exitCode = prevCode;
  }
}

test('buildCmd 生成带 CRLF 的启动命令', () => {
  const root = 'D:\\bridge';
  const execPath = 'C:\\node\\node.exe';
  const logPath = 'D:\\bridge\\logs\\daemon.log';
  const cmd = buildCmd({ root, execPath, logPath });

  assert.match(cmd, /cd \/d "/);
  assert.ok(cmd.includes('bin\\daemon.js'));
  assert.ok(cmd.includes('>>'));
  assert.ok(cmd.includes(logPath));
  assert.ok(cmd.includes(execPath));
  assert.ok(cmd.includes('2>&1'));
  assert.deepEqual(cmd.split('\r\n'), [
    '@echo off',
    `cd /d "${root}"`,
    `"${execPath}" "${path.join(root, 'bin', 'daemon.js')}" >> "${logPath}" 2>&1`,
    '',
  ]);
});

test('buildVbs 生成带唤醒与重试延迟的脚本', () => {
  const cmdPath = 'D:\\state\\daemon-autostart.cmd';
  const root = 'D:\\bridge';
  const vbs = buildVbs({ cmdPath, root });

  assert.ok(vbs.includes('WScript.Sleep 15000'));
  assert.ok(vbs.includes('WScript.Sleep 60000'));
  assert.ok(vbs.includes('sh.Run'));
  assert.ok(vbs.includes('Chr(34)'));
  assert.ok(vbs.includes(root));
  assert.ok(vbs.includes(cmdPath));
  assert.ok(vbs.includes('Dim sh, rc'));
  assert.ok(vbs.includes(', 0, True)'));
  assert.ok(vbs.includes('If rc = 0 Then Exit Do'));
  assert.ok(!vbs.includes(', 1,'));
  assert.ok(vbs.endsWith('\r\n'));
});

test('buildVbs 对 CurrentDirectory/Run 的失败做 Err 检查并重试', () => {
  const vbs = buildVbs({ cmdPath: 'D:\\state\\daemon-autostart.cmd', root: 'D:\\bridge' });

  assert.ok(vbs.includes('On Error Resume Next'));
  assert.ok(vbs.includes('Err.Number'));
  assert.ok(vbs.includes('Err.Clear'));
  assert.equal((vbs.match(/WScript\.Sleep 60000/g) || []).length, 3, '三类失败都应等待重试');
});

test('buildXml 生成登录触发的任务计划 XML', () => {
  const sid = 'S-1-5-21-1-2-3';
  const vbsPath = 'D:\\state\\daemon-autostart.vbs';
  const xml = buildXml({ sid, vbsPath });

  assert.ok(xml.includes('<?xml version="1.0" encoding="UTF-16"?>'));
  assert.ok(xml.includes('<Task version="1.2"'));
  assert.ok(xml.includes('LogonTrigger'));
  assert.ok(xml.includes(`<UserId>${sid}</UserId>`));
  assert.ok(xml.includes('InteractiveToken'));
  assert.ok(xml.includes('LeastPrivilege'));
  assert.ok(xml.includes('IgnoreNew'));
  assert.ok(xml.includes('PT0S'));
  assert.ok(xml.includes('<Hidden>true</Hidden>'));
  assert.ok(xml.includes('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'));
  assert.ok(xml.includes('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'));
  assert.ok(xml.includes('<StartWhenAvailable>true</StartWhenAvailable>'));
  assert.ok(xml.includes('Principal id="Author"'));
  assert.ok(xml.includes('<Command>wscript.exe</Command>'));
  assert.ok(xml.includes(vbsPath));
  assert.ok(xml.includes('飞书终端桥守护进程'));
});

test('buildXml 转义动态字段里的 & < >', () => {
  const xml = buildXml({ sid: 'S-1-5-21-1-2-3', vbsPath: 'D:\\a&b\\<c>\\d.vbs' });

  assert.ok(xml.includes('D:\\a&amp;b\\&lt;c&gt;\\d.vbs'));
  assert.ok(!xml.includes('a&b'));
  assert.ok(!xml.includes('<c>'));
});

test('currentSid 从 whoami CSV 输出解析 SID（System32 绝对路径）', () => {
  const calls = [];
  const out = `"PC","user","S-1-5-21-1004336348-1177238915-682003330-1001","S-1-5-21-..."`;
  const sid = currentSid(fakeRun(calls, () => out));

  assert.equal(sid, 'S-1-5-21-1004336348-1177238915-682003330-1001');
  assert.match(calls[0][0], /System32[\\/]whoami\.exe$/i, 'whoami 应使用 System32 绝对路径');
  assert.deepEqual(calls[0][1], ['/user', '/fo', 'csv', '/nh']);
});

test('currentSid 支持 S-1-12 开头的 SID', () => {
  assert.equal(currentSid(() => 'S-1-12-1-4294967295-1234'), 'S-1-12-1-4294967295-1234');
});

test('currentSid 空输出抛错并带出原始输出', () => {
  assert.throws(
    () => currentSid(() => ''),
    /无法从 whoami 输出中解析 SID：/,
  );
});

test('taskExists 解析真实 CSV 首字段（前导反斜杠/大小写/空白/逗号）', () => {
  assert.equal(taskExists(() => taskLine()), true, '根任务首字段带前导反斜杠');
  assert.equal(taskExists(() => `"Other","N/A","就绪"\r\n${taskLine()}`), true, '多行中命中');
  assert.equal(taskExists(() => `"\\\\FeishuBridge.Daemon","N/A","就绪"`), true, '多个前导反斜杠');
  assert.equal(taskExists(() => `"\\FeishuBridge.Daemon ","N/A","就绪"`), true, '任务名尾部空白应 trim');
  assert.equal(taskExists(() => `"\\feishubridge.daemon","N/A","就绪"`), true, '任务名大小写不敏感');
  assert.equal(taskExists(() => `"\\Microsoft\\Windows\\FeishuBridge.Daemon","N/A","就绪"`), false, '子目录任务不匹配');
  assert.equal(taskExists(() => `"\\Microsoft\\Windows\\Foo","N/A","就绪"`), false, '其他子目录任务不匹配');
  assert.equal(taskExists(() => `"\\FeishuBridge.Daemon2","N/A","就绪"`), false, '前缀相同的其他任务不匹配');
  assert.equal(taskExists(() => '"Other,Task","N/A","就绪"'), false, '引号内逗号不应误判');
  assert.equal(taskExists(() => `"\\FeishuBridge.Daemon,Extra","N/A","就绪"`), false, '任务名内含逗号不应误判');
  assert.equal(taskExists(() => '"Other","N/A","就绪"'), false);
});

test('taskExists 查询失败时抛中文错误，不当成不存在', () => {
  assert.throws(() => taskExists(() => { throw new Error('服务未启动'); }), /无法查询计划任务：服务未启动/);
});

test('install 写三个文件并调用一次 schtasks（不落真实命令）', (t) => {
  const dir = tmpdir(t);
  const stateDir = path.join(dir, 'state');
  const logPath = path.join(dir, 'logs', 'daemon.log');
  const calls = [];
  const sid = 'S-1-5-21-1-2-3';

  const ret = install({
    root: dir,
    execPath: 'C:\\node\\node.exe',
    stateDir,
    logPath,
    sid,
    run: fakeRun(calls),
  });

  const cmdPath = path.join(stateDir, CMD_NAME);
  const vbsPath = path.join(stateDir, VBS_NAME);
  const xmlPath = path.join(stateDir, XML_NAME);

  assert.ok(fs.existsSync(cmdPath), 'cmd 文件应存在');
  assert.ok(fs.existsSync(vbsPath), 'vbs 文件应存在');
  assert.ok(fs.existsSync(xmlPath), 'xml 文件应存在');
  assert.ok(fs.existsSync(path.dirname(logPath)), 'log 目录应被创建');

  const head = fs.readFileSync(xmlPath).subarray(0, 2);
  assert.deepEqual([...head], [0xFF, 0xFE], 'xml 应为 UTF-16LE BOM');

  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /System32[\\/]schtasks\.exe$/i);
  const args = calls[0][1];
  for (const part of ['/Create', '/TN', TASK, '/XML', xmlPath, '/F']) {
    assert.ok(args.includes(part), `schtasks 参数应包含 ${part}`);
  }

  assert.equal(ret.ok, true);
  assert.equal(ret.dryRun, false);
  assert.equal(ret.sid, sid);
  assert.deepEqual(ret.files, [cmdPath, vbsPath, xmlPath]);
});

test('install --dry-run 零副作用、不调用 run/currentSid（不注入 sid）', (t) => {
  const dir = tmpdir(t);
  const stateDir = path.join(dir, 'state');
  const logPath = path.join(dir, 'logs', 'daemon.log');
  const calls = [];
  const prevLog = console.log;
  console.log = () => {};

  let ret;
  try {
    ret = install({
      root: dir,
      execPath: 'C:\\node\\node.exe',
      stateDir,
      logPath,
      run: fakeRun(calls),
      dryRun: true,
    });
  } finally {
    console.log = prevLog;
  }

  assert.equal(ret.ok, true);
  assert.equal(ret.dryRun, true);
  assert.deepEqual(ret.files, [
    path.join(stateDir, CMD_NAME),
    path.join(stateDir, VBS_NAME),
    path.join(stateDir, XML_NAME),
  ]);
  assert.equal(fs.existsSync(stateDir), false, 'dry-run 不应创建 state 目录');
  assert.equal(fs.existsSync(path.dirname(logPath)), false, 'dry-run 不应创建 logs 目录');
  assert.equal(fs.existsSync(path.join(stateDir, CMD_NAME)), false);
  assert.equal(fs.existsSync(path.join(stateDir, VBS_NAME)), false);
  assert.equal(fs.existsSync(path.join(stateDir, XML_NAME)), false);
  assert.equal(calls.length, 0, 'dry-run 不应调用 whoami/schtasks');
});

test('install 拒绝含中文/非 ASCII 的路径，且不写文件、不调 schtasks', (t) => {
  const dir = tmpdir(t);
  const stateDir = path.join(dir, 'state');
  const logPath = path.join(dir, 'logs', 'daemon.log');
  const calls = [];

  assert.throws(
    () => install({
      root: 'D:\\中文工程',
      execPath: 'C:\\node\\node.exe',
      stateDir,
      logPath,
      sid: 'S-1-5-21-1-2-3',
      run: fakeRun(calls),
    }),
    /开机自启暂不支持含中文\/非 ASCII 或 % 的路径：D:\\中文工程/,
  );
  assert.equal(calls.length, 0, '校验失败不应调用任何命令');
  assert.equal(fs.existsSync(stateDir), false, '校验失败不应创建 state 目录');
  assert.equal(fs.existsSync(path.dirname(logPath)), false, '校验失败不应创建 logs 目录');
});

test('install 拒绝含 % 的路径', (t) => {
  const dir = tmpdir(t);
  const stateDir = path.join(dir, 'state');
  const logPath = path.join(dir, 'logs', '100%', 'daemon.log');
  const calls = [];

  assert.throws(
    () => install({
      root: dir,
      execPath: 'C:\\node\\node.exe',
      stateDir,
      logPath,
      sid: 'S-1-5-21-1-2-3',
      run: fakeRun(calls),
    }),
    /开机自启暂不支持含中文\/非 ASCII 或 % 的路径：.*100%/,
  );
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(stateDir), false);
});

test('uninstall 结束并删除任务、清理文件', (t) => {
  const dir = tmpdir(t);
  const calls = [];
  writeScripts(dir);
  let deleted = false;

  const ret = uninstall({
    stateDir: dir,
    run: fakeRun(calls, (file, args) => {
      if (args[0] === '/Query') return deleted ? taskLine('Other') : taskLine();
      if (args[0] === '/Delete') { deleted = true; return ''; }
      return '';
    }),
  });

  assert.deepEqual(ret, { ok: true, installed: true });
  const flat = calls.flatMap(([file, args]) => [file, ...args]);
  assert.ok(flat.includes('/End'));
  assert.ok(flat.includes('/Delete'));
  assert.ok(flat.includes('/F'));
  assert.ok(calls.filter(([, args]) => args[0] === '/Query').length >= 2, '删除后应复查');
  for (const name of [CMD_NAME, VBS_NAME, XML_NAME]) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} 应被删除`);
  }
});

test('uninstall 在任务不存在时清理残留脚本并返回未安装', (t) => {
  const dir = tmpdir(t);
  const calls = [];
  writeScripts(dir);

  const ret = uninstall({
    stateDir: dir,
    run: fakeRun(calls, () => taskLine('Other')),
  });

  assert.deepEqual(ret, { ok: true, installed: false });
  assert.ok(!calls.some(([, args]) => args[0] === '/Delete'), '任务不存在时不应 /Delete');
  for (const name of [CMD_NAME, VBS_NAME, XML_NAME]) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} 应被删除`);
  }
});

test('/Delete 被拒绝时 uninstall 抛错并保留脚本文件', (t) => {
  const dir = tmpdir(t);
  writeScripts(dir);

  assert.throws(
    () => uninstall({
      stateDir: dir,
      run: fakeRun([], (file, args) => {
        if (args[0] === '/Query') return taskLine();
        if (args[0] === '/Delete') throw new Error('Access is denied.');
        return '';
      }),
    }),
    /删除计划任务失败：Access is denied\.（脚本文件已保留）/,
  );

  for (const name of [CMD_NAME, VBS_NAME, XML_NAME]) {
    assert.ok(fs.existsSync(path.join(dir, name)), `${name} 应保留`);
  }
});

test('任务不存在时清理脚本并返回 installed:false（不调用 /Delete）', (t) => {
  const dir = tmpdir(t);
  writeScripts(dir);
  const calls = [];

  const ret = uninstall({
    stateDir: dir,
    run: fakeRun(calls, (file, args) => {
      if (args[0] === '/Query') return '"Other","N/A","就绪"';
      throw new Error('not found');
    }),
  });

  assert.deepEqual(ret, { ok: true, installed: false });
  assert.equal(calls.some(([, args]) => args[0] === '/Delete'), false, '任务不存在时不应调用 /Delete');
  for (const name of [CMD_NAME, VBS_NAME, XML_NAME]) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} 应被删除`);
  }
});

test('/Delete 报 not found 后复查该任务已不存在，视为卸载成功', (t) => {
  const dir = tmpdir(t);
  writeScripts(dir);
  let queries = 0;

  const ret = uninstall({
    stateDir: dir,
    run: fakeRun([], (file, args) => {
      if (args[0] === '/Query') {
        queries += 1;
        return queries === 1 ? taskLine() : '"Other","N/A","就绪"';
      }
      if (args[0] === '/Delete') throw new Error('ERROR: 系统找不到指定的文件。');
      return '';
    }),
  });

  assert.deepEqual(ret, { ok: true, installed: true });
  assert.ok(queries >= 2, 'Delete 失败后应重新查询');
  for (const name of [CMD_NAME, VBS_NAME, XML_NAME]) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} 应被删除`);
  }
});

test('/Delete 成功后复查仍在则抛错并保留脚本', (t) => {
  const dir = tmpdir(t);
  writeScripts(dir);

  assert.throws(
    () => uninstall({
      stateDir: dir,
      run: fakeRun([], (file, args) => (args[0] === '/Query' ? taskLine() : '')),
    }),
    /删除计划任务失败：任务仍然存在（脚本文件已保留）/,
  );

  for (const name of [CMD_NAME, VBS_NAME, XML_NAME]) {
    assert.ok(fs.existsSync(path.join(dir, name)), `${name} 应保留`);
  }
});

test('uninstall/status 查询失败时抛中文错误', (t) => {
  const dir = tmpdir(t);
  const run = () => { throw new Error('服务未启动'); };

  assert.throws(() => uninstall({ stateDir: dir, run }), /无法查询计划任务：服务未启动/);
  assert.throws(() => status({ run }), /无法查询计划任务：服务未启动/);
});

test('status 用 CSV 全量查询并判断是否已安装', () => {
  const calls = [];
  const installed = status({ run: fakeRun(calls, () => taskLine()) });

  assert.deepEqual(installed, { installed: true });
  assert.match(calls[0][0], /System32[\\/]schtasks\.exe$/i, 'schtasks 应使用 System32 绝对路径');
  assert.deepEqual(calls[0][1], ['/Query', '/FO', 'CSV', '/NH']);

  const absent = status({ run: fakeRun([], () => '"Other","N/A","就绪"') });
  assert.deepEqual(absent, { installed: false });
});

test('main：参数错误退出码为 2', () => {
  assert.equal(runMain(['bogus']).code, 2);
  assert.equal(runMain(['status', 'extra']).code, 2);
  assert.equal(runMain(['install', '--bad']).code, 2);
});

test('main：install 的 schtasks 失败时退出码 1、中文报错且无裸栈', (t) => {
  const dir = tmpdir(t);
  const stateDir = path.join(dir, 'state');
  const logPath = path.join(dir, 'logs', 'daemon.log');

  const { code, stderr } = runMain(['install'], {
    install: {
      root: dir,
      execPath: 'C:\\node\\node.exe',
      stateDir,
      logPath,
      sid: 'S-1-5-21-1-2-3',
      run: () => { throw new Error('Access is denied.'); },
    },
  });

  assert.equal(code, 1);
  assert.match(stderr, /错误：脚本已写入 state\/，但计划任务未创建：Access is denied\./);
  assert.doesNotMatch(stderr, /^\s+at /m, '不应输出裸栈');
  assert.ok(fs.existsSync(path.join(stateDir, CMD_NAME)), '脚本应已写入');
});

test('main：status 查询失败时退出码 1 且中文报错', () => {
  const { code, stderr } = runMain(['status'], {
    status: { run: () => { throw new Error('服务未启动'); } },
  });

  assert.equal(code, 1);
  assert.match(stderr, /错误：无法查询计划任务：服务未启动/);
  assert.doesNotMatch(stderr, /^\s+at /m);
});

test('main：uninstall 任务不存在时提示已清理残留脚本', (t) => {
  const dir = tmpdir(t);
  writeScripts(dir);

  const { code, stdout } = runMain(['uninstall'], {
    uninstall: { stateDir: dir, run: () => '"Other","N/A","就绪"' },
  });

  assert.ok(!code, '成功路径退出码应为 0');
  assert.match(stdout, /未安装，已清理残留脚本/);
  for (const name of [CMD_NAME, VBS_NAME, XML_NAME]) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} 应被删除`);
  }
});

test('main：uninstall 成功时提示已卸载计划任务', (t) => {
  const dir = tmpdir(t);
  writeScripts(dir);
  let deleted = false;

  const { code, stdout } = runMain(['uninstall'], {
    uninstall: {
      stateDir: dir,
      run: (file, args) => {
        if (args[0] === '/Query') return deleted ? '"Other","N/A","就绪"' : taskLine();
        if (args[0] === '/Delete') { deleted = true; return ''; }
        return '';
      },
    },
  });

  assert.ok(!code);
  assert.match(stdout, /已卸载计划任务：FeishuBridge\.Daemon/);
});
