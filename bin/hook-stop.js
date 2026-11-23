#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const BUDGET_MS = 2000;
const startedAt = Date.now();

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(buf); } };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', finish);
    setTimeout(finish, 800);
  });
}

function post({ port, token, session, body }) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: `/hook/stop?session=${encodeURIComponent(session)}`,
      headers: {
        'content-type': 'application/json',
        'x-bridge-token': token,
        'content-length': Buffer.byteLength(body),
      },
      timeout: Math.max(300, BUDGET_MS - (Date.now() - startedAt)),
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', resolve);
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end(body);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--session');
  const session = i >= 0 ? args[i + 1] : '';
  const ipcFile = process.env.FEISHU_BRIDGE_IPC
    || path.join(__dirname, '..', 'state', 'ipc.json');

  const body = await readStdin();
  if (!session || !fs.existsSync(ipcFile)) return;

  let ipc;
  try {
    ipc = JSON.parse(fs.readFileSync(ipcFile, 'utf8'));
  } catch {
    return;
  }
  await post({ port: ipc.port, token: ipc.token, session, body });
}

main().catch(() => {}).finally(() => process.exit(0));
