const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const PS_PROTECT = [
  'Add-Type -AssemblyName System.Security;',
  '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());',
  "$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');",
  '[Console]::Out.Write([Convert]::ToBase64String($e))',
].join(' ');

const PS_UNPROTECT = PS_PROTECT.replace('Protect($b,$null', 'Unprotect($b,$null');

function runPowerShell(script, inputB64) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: inputB64,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  }).trim();
}

function restrictAcl(file) {
  execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:R`], {
    windowsHide: true,
    timeout: 10000,
  });
}

function createSecretStore({ file, runner = runPowerShell, acl = restrictAcl, log = { warn() {} } }) {
  return {
    save(plain) {
      const b64 = Buffer.from(plain, 'utf8').toString('base64');
      let record;
      try {
        record = { mode: 'dpapi', data: runner(PS_PROTECT, b64) };
      } catch (err) {
        log.warn('secret.dpapi_failed', { error: String((err && err.message) || err) });
        record = { mode: 'plain', data: b64 };
      }
      fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
      if (record.mode === 'plain') acl(file);
      return record.mode;
    },
    load() {
      if (!fs.existsSync(file)) return null;
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      const b64 = rec.mode === 'dpapi' ? runner(PS_UNPROTECT, rec.data) : rec.data;
      return Buffer.from(b64, 'base64').toString('utf8');
    },
  };
}

module.exports = {
  createSecretStore, runPowerShell, restrictAcl, PS_PROTECT, PS_UNPROTECT,
};
