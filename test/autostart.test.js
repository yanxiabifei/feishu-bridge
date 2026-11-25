const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  TASK,
  buildCmd,
  buildVbs,
  buildXml,
  install,
  uninstall,
  status,
} = require('../scripts/autostart');

const CMD_NAME = 'daemon-autostart.cmd';
const VBS_NAME = 'daemon-autostart.vbs';
const XML_NAME = 'daemon-autostart.xml';

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-autostart-'));
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
  assert.ok(xml.includes('<StartWhenAvailable>false</StartWhenAvailable>'));
  assert.ok(xml.includes('Principal id="Author"'));
  assert.ok(xml.includes('<Command>wscript.exe</Command>'));
  assert.ok(xml.includes(vbsPath));
  assert.ok(xml.includes('飞书终端桥守护进程'));
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
  assert.equal(calls[0][0], 'schtasks');
  const args = calls[0][1];
  for (const part of ['/Create', '/TN', TASK, '/XML', xmlPath, '/F']) {
    assert.ok(args.includes(part), `schtasks 参数应包含 ${part}`);
  }

  assert.equal(ret.ok, true);
  assert.equal(ret.dryRun, false);
  assert.equal(ret.sid, sid);
  assert.deepEqual(ret.files, [cmdPath, vbsPath, xmlPath]);
});

test('install --dry-run 零副作用、不调用 schtasks', (t) => {
  const dir = tmpdir(t);
  const stateDir = path.join(dir, 'state');
  const logPath = path.join(dir, 'logs', 'daemon.log');
  const calls = [];

  const ret = install({
    root: dir,
    execPath: 'C:\\node\\node.exe',
    stateDir,
    logPath,
    sid: 'S-1-5-21-1-2-3',
    run: fakeRun(calls),
    dryRun: true,
  });

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
  assert.equal(calls.length, 0, 'dry-run 不应调用 schtasks');
});

test('uninstall 结束并删除任务、清理文件', (t) => {
  const dir = tmpdir(t);
  const calls = [];
  for (const name of [CMD_NAME, VBS_NAME, XML_NAME]) {
    fs.writeFileSync(path.join(dir, name), 'x');
  }

  const ret = uninstall({ stateDir: dir, run: fakeRun(calls) });

  assert.deepEqual(ret, { ok: true });
  const flat = calls.flatMap(([file, args]) => [file, ...args]);
  assert.ok(flat.includes('/End'));
  assert.ok(flat.includes('/Delete'));
  assert.ok(flat.includes('/F'));
  for (const name of [CMD_NAME, VBS_NAME, XML_NAME]) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} 应被删除`);
  }
});

test('uninstall 在任务不存在时也不抛错', (t) => {
  const dir = tmpdir(t);
  const run = () => { throw new Error('没有这个任务'); };

  const ret = uninstall({ stateDir: dir, run });
  assert.deepEqual(ret, { ok: true });
});

test('status 根据 schtasks 查询结果判断是否已安装', () => {
  assert.deepEqual(status({ run: () => '任务名: FeishuBridge.Daemon' }), { installed: true });
  assert.deepEqual(status({ run: () => { throw new Error('找不到'); } }), { installed: false });
});
