// 子进程：开一个真实 ConPTY 会话，让 fake-agent 执行 /exit 自己退出。
// 修复前 conout Worker 的 MessagePort 不释放，本进程跑完也不会退出；
// 修复后 onExit 补的 pty.kill() 会 dispose Worker，事件循环自然空掉。
const path = require('node:path');
const pty = require('node-pty');
const { createPtySession } = require('../../src/session/ptySession');
const { createScreen } = require('../../src/screen');
const { createQueue } = require('../../src/session/queue');

const session = {
  id: 'leak', chatId: 'oc_leak', agent: 'fake', cwd: process.cwd(),
  status: 'idle', inputSeq: 0, lastInput: null,
};

const ps = createPtySession({
  session,
  launch: () => ({
    file: process.execPath,
    args: [path.join(__dirname, 'fake-agent.js')],
    cwd: process.cwd(),
  }),
  ptyFactory: pty.spawn,
  screenFactory: createScreen,
  queueFactory: createQueue,
  onEvent(e) {
    if (e.type === 'ready') ps.submitText('/exit', 'phone');
    if (e.type === 'exit') process.stdout.write('CHILD_CLOSED\n');
  },
});

ps.start();
// 不调 process.exit()：句柄都清干净的话，事件循环会自己结束。
