// 验收测试用的假 agent：一个提示符，收到一行就回显一行。
process.stdout.write('FAKE_AGENT_READY\r\n');
process.stdout.write('❯ ');

const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const text = line.trim();
  if (text === '/exit') {
    process.stdout.write('\r\nBYE\r\n');
    process.exit(0);
  }
  process.stdout.write(`\r\nECHO:${text}\r\n❯ `);
});
rl.on('close', () => process.exit(0));
