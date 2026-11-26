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
const SYSTEM_ROOT = process.env.SystemRoot || process.env.windir || 'C:\\Windows';

// Git Bash 的 PATH 里可能先命中 MSYS 版 whoami（不认 /user 参数），
// 因此 whoami/schtasks 一律走 System32 绝对路径，避免任何 PATH 歧义。
function system32(exe) {
  return path.join(SYSTEM_ROOT, 'System32', exe);
}

// 先按 GBK（中文 Windows 控制台默认代码页）解码子进程输出；运行环境没有完整 ICU
// 时退回 UTF-8，避免把 CP936 乱码直接透传到终端。
function decodeOutput(buf) {
  if (buf == null) return '';
  if (typeof buf === 'string') return buf;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  }
}

function defaultRun(file, args) {
  let stdout;
  try {
    stdout = execFileSync(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const detail = decodeOutput(err.stderr).trim() || decodeOutput(err.stdout).trim() || err.message;
    throw new Error(detail);
  }
  return decodeOutput(stdout).trim();
}

function currentSid(run = defaultRun) {
  const out = run(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  const found = /S-1-\d+-[\d-]+/.exec(out);
  if (!found) throw new Error(`无法从 whoami 输出中解析 SID：${out}`);
  return found[0];
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildCmd({ root, execPath, logPath }) {
  // 这些路径在 install 中已校验为纯 ASCII 且不含 %，UTF-8 写入的字节与 CP936
  // 解码 ASCII 完全一致，cmd/wscript 读脚本不会乱码，因此无需另存 UTF-16。
  return [
    '@echo off',
    `cd /d "${root}"`,
    `"${execPath}" "${path.join(root, 'bin', 'daemon.js')}" >> "${logPath}" 2>&1`,
  ].join('\r\n') + '\r\n';
}

function buildVbs({ cmdPath, root, wakeMs = WAKE_DELAY_MS, retryMs = RETRY_DELAY_MS }) {
  // 同上：cmdPath/root 在 install 中已校验为纯 ASCII，按 UTF-8 写入即可被 wscript 正确读取。
  return [
    'Option Explicit',
    'Dim sh, rc',
    'Set sh = CreateObject("WScript.Shell")',
    `WScript.Sleep ${wakeMs}`,
    'On Error Resume Next',
    'Do',
    `  sh.CurrentDirectory = "${root}"`,
    '  If Err.Number <> 0 Then',
    '    Err.Clear',
    `    WScript.Sleep ${retryMs}`,
    '  Else',
    `    rc = sh.Run(Chr(34) & "${cmdPath}" & Chr(34), 0, True)`,
    '    If Err.Number <> 0 Then',
    '      Err.Clear',
    `      WScript.Sleep ${retryMs}`,
    '    ElseIf rc = 0 Then Exit Do',
    '    Else',
    `      WScript.Sleep ${retryMs}`,
    '    End If',
    '  End If',
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
    '    <StartWhenAvailable>true</StartWhenAvailable>',
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
  const bom = Buffer.from([0xFF, 0xFE]);
  fs.writeFileSync(file, Buffer.concat([bom, Buffer.from(text, 'utf16le')]));
}

// 嵌入 VBS/CMD 的路径必须纯 ASCII 且不含 %：前者避免 CP936 解码乱码，
// 后者避免 cmd 在双引号内仍展开 %VAR%。
const SAFE_PATH = /^[\x20-\x7E]+$/;

function assertSafePath(p) {
  if (!SAFE_PATH.test(p) || p.includes('%')) {
    throw new Error(`开机自启暂不支持含中文/非 ASCII 或 % 的路径：${p}。请把工程和 Node 移到纯英文路径后重试。`);
  }
}

// 取 CSV 第一字段：允许引号内含逗号，去掉引号后 trim。
function firstCsvField(line) {
  const s = line.trim();
  if (!s.startsWith('"')) {
    const comma = s.indexOf(',');
    return (comma === -1 ? s : s.slice(0, comma)).trim();
  }
  let out = '';
  for (let i = 1; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '"') {
      if (s[i + 1] === '"') {
        out += '"';
        i += 1;
        continue;
      }
      break;
    }
    out += ch;
  }
  return out.trim();
}

function taskExists(run = defaultRun) {
  let out;
  try {
    out = run(system32('schtasks.exe'), ['/Query', '/FO', 'CSV', '/NH']);
  } catch (err) {
    throw new Error(`无法查询计划任务：${err.message}`);
  }
  const target = TASK.toLowerCase();
  return String(out)
    .split(/\r?\n/)
    .some((line) => {
      // 真实输出里根任务首字段是 "\FeishuBridge.Daemon"；子目录任务带
      // "\Microsoft\Windows\..." 前缀，去掉前导反斜杠后不可能等于 TASK。
      const name = firstCsvField(line).replace(/^\\+/, '').toLowerCase();
      return name === target;
    });
}

function removeScripts(stateDir) {
  for (const name of [CMD_NAME, VBS_NAME, XML_NAME]) {
    const file = path.join(stateDir, name);
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      throw new Error(`删除脚本文件失败：${file}（${err.message}）`);
    }
  }
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

  // 写文件、建目录、调 schtasks 之前先完成校验，失败时不留任何副作用。
  for (const p of [root, execPath, logPath, cmdPath, vbsPath, xmlPath]) {
    assertSafePath(p);
  }

  if (dryRun) {
    console.log(`cmd：${cmdPath}`);
    console.log(`vbs：${vbsPath}`);
    console.log(`xml：${xmlPath}`);
    console.log(`任务名：${TASK}`);
    return { ok: true, dryRun: true, files: [cmdPath, vbsPath, xmlPath] };
  }

  const realSid = sid || currentSid(run);
  const cmd = buildCmd({ root, execPath, logPath });
  const vbs = buildVbs({ cmdPath, root });
  const xml = buildXml({ sid: realSid, vbsPath });

  fs.mkdirSync(stateDir, { recursive: true });
  // cmd 里用 >> 重定向日志，父目录不存在会直接失败，daemon 就起不来
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(cmdPath, cmd, 'utf8');
  fs.writeFileSync(vbsPath, vbs, 'utf8');
  writeUtf16(xmlPath, xml);
  try {
    run(system32('schtasks.exe'), ['/Create', '/TN', TASK, '/XML', xmlPath, '/F']);
  } catch (err) {
    throw new Error(`脚本已写入 state/，但计划任务未创建：${err.message}`);
  }
  return { ok: true, dryRun: false, files: [cmdPath, vbsPath, xmlPath], sid: realSid };
}

function uninstall({ run = defaultRun, stateDir = paths.STATE } = {}) {
  if (!taskExists(run)) {
    removeScripts(stateDir);
    return { ok: true, installed: false };
  }

  try { run(system32('schtasks.exe'), ['/End', '/TN', TASK]); } catch { /* 任务可能没在运行 */ }
  try {
    run(system32('schtasks.exe'), ['/Delete', '/TN', TASK, '/F']);
  } catch (err) {
    // /Delete 报错不一定是失败：任务可能已被并发删掉。复查确认消失才算成功。
    if (!taskExists(run)) {
      removeScripts(stateDir);
      return { ok: true, installed: true };
    }
    // 任务还注册着，但 VBS 已删会让每次登录都报“找不到脚本”，所以保留脚本。
    throw new Error(`删除计划任务失败：${err.message}（脚本文件已保留）`);
  }
  if (taskExists(run)) {
    throw new Error('删除计划任务失败：任务仍然存在（脚本文件已保留）');
  }
  removeScripts(stateDir);
  return { ok: true, installed: true };
}

function status({ run = defaultRun } = {}) {
  return { installed: taskExists(run) };
}

const USAGE = '用法：node scripts/autostart.js <install|uninstall|status> [--dry-run]';

function main(argv = process.argv.slice(2), options = {}) {
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

  try {
    if (command === 'install') {
      const dryRun = rest.includes('--dry-run');
      install({ ...options.install, dryRun });
      console.log(dryRun ? '（dry-run：未写入文件，也未创建计划任务）' : `已安装计划任务：${TASK}`);
      return;
    }
    if (command === 'uninstall') {
      const ret = uninstall(options.uninstall);
      console.log(ret.installed ? `已卸载计划任务：${TASK}` : `未安装，已清理残留脚本：${TASK}`);
      return;
    }

    const { installed } = status(options.status);
    console.log(installed ? `已安装：${TASK}` : `未安装：${TASK}`);
  } catch (err) {
    // 只输出可读中文原因，不把裸栈丢给用户。
    console.error('错误：' + err.message);
    process.exitCode = 1;
  }
}

module.exports = {
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
};

if (require.main === module) main();
