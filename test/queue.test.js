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

test('drain 返回未处理的项并清空', () => {
  const q = createQueue({ canWrite: () => false, write: () => {} });
  q.push('a');
  q.push('b');
  assert.deepStrictEqual(q.drain(), ['a', 'b']);
  assert.strictEqual(q.pending(), 0);
  assert.strictEqual(q.inFlight(), false);
});

test('write 抛异常时不把队列卡死，交给 onError', () => {
  const errors = [];
  const q = createQueue({
    canWrite: () => true,
    write: () => { throw new Error('boom'); },
    onError: (e) => errors.push(e.message),
  });
  q.push('a');
  assert.deepStrictEqual(errors, ['boom']);
  assert.strictEqual(q.inFlight(), false);
});
