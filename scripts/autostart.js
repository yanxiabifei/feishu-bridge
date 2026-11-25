const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../src/paths');

const TASK = 'FeishuBridge.Daemon';
const WAKE_DELAY_MS = 15000;
const RETRY_DELAY_MS = 60000;
const CMD_NAME = 'daemon-autostart.cmd';
const VBS_NAME = 'daemon-autostart.vbs';
const XML_NAME = 'daemon-autostart.xml';

function defaultRun(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', windowsHide: true }).trim();
}

function currentSid(run = defaultRun) {
  const out = run('C:\\Windows\\System32\\whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  const found = /S-1-5-[\d-]+/.exec(out);
  if (!found) throw new Error('无法确定当前用户 SID');
  return found[0];
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildCmd({ root, execPath, logPath }) {
  return [
    '@echo off',
    `cd /d "${root}"`,
    `"${execPath}" "${path.join(root, 'bin', 'daemon.js')}" >> "${logPath}" 2>&1`,
  ].join('\r\n') + '\r\n';
}

function buildVbs({ cmdPath, root, wakeMs = WAKE_DELAY_MS, retryMs = RETRY_DELAY_MS }) {
  return [
    'Option Explicit',
    'Dim sh, rc',
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${root}"`,
    `WScript.Sleep ${wakeMs}`,
    'Do',
    `  rc = sh.Run(Chr(34) & "${cmdPath}" & Chr(34), 0, True)`,
    '  If rc = 0 Then Exit Do',
    `  WScript.Sleep ${retryMs}`,
    'Loop',
  ].join('\r\n') + '\r\n';
}

function buildXml({ sid, vbsPath }) {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>飞书终端桥守护进程</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${escapeXml(sid)}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${escapeXml(sid)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    // 这里沿用 Windows 导出任务的标准 Settings 集合；多出的项都是默认值，
    // 为保证 schtasks 能接受 XML 而保留（本任务不真装，无法实测精简后的 schema）。
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>false</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>true</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>wscript.exe</Command>',
    `      <Arguments>"${escapeXml(vbsPath)}"</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
  ].join('\r\n') + '\r\n';
}

function writeUtf16(file, text) {
  fs.writeFileSync(file, '\uFEFF' + text, 'utf16le');
}

function install({
  root = paths.ROOT,
  execPath = process.execPath,
  stateDir = paths.STATE,
  logPath = path.join(paths.LOGS, 'daemon.log'),
  run = defaultRun,
  sid = null,
  dryRun = false,
} = {}) {
  const cmdPath = path.join(stateDir, CMD_NAME);
  const vbsPath = path.join(stateDir, VBS_NAME);
  const xmlPath = path.join(stateDir, XML_NAME);

  const realSid = sid || currentSid(run);
  const cmd = buildCmd({ root, execPath, logPath });
  const vbs = buildVbs({ cmdPath, root });
  const xml = buildXml({ sid: realSid, vbsPath });

  if (dryRun) {
    console.log(`cmd：${cmdPath}`);
    console.log(`vbs：${vbsPath}`);
    console.log(`xml：${xmlPath}`);
    console.log(`任务名：${TASK}`);
    return { ok: true, dryRun: true, files: [cmdPath, vbsPath, xmlPath] };
  }

  fs.mkdirSync(stateDir, { recursive: true });
  // cmd 里用 >> 重定向日志，父目录不存在会直接失败，daemon 就起不来
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(cmdPath, cmd, 'utf8');
  fs.writeFileSync(vbsPath, vbs, 'utf8');
  writeUtf16(xmlPath, xml);
  run('schtasks', ['/Create', '/TN', TASK, '/XML', xmlPath, '/F']);
  return { ok: true, dryRun: false, files: [cmdPath, vbsPath, xmlPath], sid: realSid };
}

function uninstall({ run = defaultRun, stateDir = paths.STATE } = {}) {
  try { run('schtasks', ['/End', '/TN', TASK]); } catch { /* 任务可能没在运行 */ }
  try { run('schtasks', ['/Delete', '/TN', TASK, '/F']); } catch { /* 任务可能不存在 */ }
  for (const name of [CMD_NAME, VBS_NAME, XML_NAME]) {
    fs.rmSync(path.join(stateDir, name), { force: true });
  }
  return { ok: true };
}

function status({ run = defaultRun } = {}) {
  try {
    run('schtasks', ['/Query', '/TN', TASK]);
    return { installed: true };
  } catch {
    return { installed: false };
  }
}

const USAGE = '用法：node scripts/autostart.js <install|uninstall|status> [--dry-run]';

function main(argv = process.argv.slice(2)) {
  const [command = 'status', ...rest] = argv;

  if (!['install', 'uninstall', 'status'].includes(command)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (command !== 'install' && rest.length > 0) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (command === 'install' && rest.some((arg) => arg !== '--dry-run')) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  if (command === 'install') {
    const dryRun = rest.includes('--dry-run');
    install({ dryRun });
    console.log(dryRun ? '（dry-run：未写入文件，也未创建计划任务）' : `已安装计划任务：${TASK}`);
    return;
  }
  if (command === 'uninstall') {
    uninstall();
    console.log(`已卸载计划任务：${TASK}`);
    return;
  }

  const { installed } = status();
  console.log(installed ? `已安装：${TASK}` : `未安装：${TASK}`);
}

module.exports = { TASK, buildCmd, buildVbs, buildXml, install, uninstall, status, main };

if (require.main === module) main();
