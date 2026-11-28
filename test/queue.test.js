const test = require('node:test');
const assert = require('node:assert');
const { createQueue } = require('../src/session/queue');

test('按到达顺序注入，且同时只有一条在途', () => {
  const written = [];
  let ready = true;
  const q = createQueue({ canWrite: () => ready, write: (x) => written.push(x) });

  q.push('a');
  q.push('b');
  q.push('c');
  assert.deepStrictEqual(written, ['a']);
  assert.strictEqual(q.pending(), 2);

  q.release();
  assert.deepStrictEqual(written, ['a', 'b']);
  q.release();
  q.release();
  assert.deepStrictEqual(written, ['a', 'b', 'c']);
  assert.strictEqual(q.inFlight(), false);
});

test('不可写时只缓存，恢复可写后自动排空', () => {
  const written = [];
  let ready = false;
  const q = createQueue({ canWrite: () => ready, write: (x) => written.push(x) });
  q.push('a');
  q.push('b');
  assert.deepStrictEqual(written, []);
  ready = true;
  q.release();
  assert.deepStrictEqual(written, ['a']);
});

test('超过上限触发 onOverflow 且不丢已有队列', () => {
  const overflow = [];
  const q = createQueue({
    limit: 3,
    canWrite: () => false,
    write: () => {},
    onOverflow: (x) => overflow.push(x),
  });
  assert.strictEqual(q.push('a'), 'queued');
  assert.strictEqual(q.push('b'), 'queued');
  assert.strictEqual(q.push('c'), 'queued');
  assert.strictEqual(q.push('d'), 'full');
  assert.deepStrictEqual(overflow, ['d']);
  assert.strictEqual(q.pending(), 3);
});

test('size 统计排队项与在途项之和', () => {
  let ready = false;
  const q = createQueue({ canWrite: () => ready, write: () => {} });
  assert.strictEqual(q.size(), 0);
  q.push('a');
  q.push('b');
  assert.strictEqual(q.size(), 2);
  ready = true;
  q.release();
  assert.strictEqual(q.inFlight(), true);
  assert.strictEqual(q.size(), 2);
});

test('在途项也计入上限', () => {
  const q = createQueue({ limit: 1, canWrite: () => true, write: () => {} });
  assert.strictEqual(q.push('a'), 'queued');
  assert.strictEqual(q.inFlight(), true);
  assert.strictEqual(q.push('b'), 'full');
});

test('不可写时连续释放两次按序排空', () => {
  const written = [];
  let ready = false;
  const q = createQueue({ canWrite: () => ready, write: (x) => written.push(x) });
  q.push('a');
  q.push('b');
  assert.deepStrictEqual(written, []);
  ready = true;
  q.release();
  assert.deepStrictEqual(written, ['a']);
  q.release();
  assert.deepStrictEqual(written, ['a', 'b']);
});

test('drain 只清空排队项，不影响在途', () => {
  const written = [];
  const q = createQueue({ canWrite: () => true, write: (x) => written.push(x) });
  q.push('turn-1');
  assert.deepStrictEqual(written, ['turn-1']);
  assert.strictEqual(q.inFlight(), true);

  assert.strictEqual(q.push('queued-2'), 'queued');
  assert.deepStrictEqual(q.drain(), ['queued-2']);
  assert.strictEqual(q.pending(), 0);
  assert.strictEqual(q.inFlight(), true);

  assert.strictEqual(q.push('turn-3'), 'queued');
  assert.deepStrictEqual(written, ['turn-1']);
  q.release();
  assert.deepStrictEqual(written, ['turn-1', 'turn-3']);
});

test('write 抛异常时不把队列卡死，消息留队重试而不是静默丢掉', () => {
  const errors = [];
  const written = [];
  let fail = true;
  const q = createQueue({
    canWrite: () => true,
    write: (x) => { if (fail) throw new Error('boom'); written.push(x); },
    onError: (e) => errors.push(e.message),
  });
  q.push('a');
  assert.deepStrictEqual(errors, ['boom']);
  assert.strictEqual(q.inFlight(), false);
  // 已经在 pump 里 shift 出来的那条必须放回去：进程退出时 dropQueue 才能把它
  // 一起报给用户，进程还活着也能在下一轮重试
  assert.strictEqual(q.pending(), 1);

  fail = false;
  q.release();
  assert.deepStrictEqual(written, ['a']);
  assert.strictEqual(q.pending(), 0);
});
