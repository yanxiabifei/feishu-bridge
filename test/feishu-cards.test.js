const test = require('node:test');
const assert = require('node:assert');
const cards = require('../src/feishu/cards');

test('truncate：未超限时原样返回', () => {
  const r = cards.truncate('短文本');
  assert.deepStrictEqual(r, { text: '短文本', truncated: false });
});

test('truncate：超限时保留头尾并标注截断', () => {
  const long = 'A'.repeat(9000) + 'END';
  const r = cards.truncate(long, 8000);
  assert.strictEqual(r.truncated, true);
  assert.ok(r.text.length < long.length);
  assert.ok(r.text.includes('已截断'));
  assert.ok(r.text.endsWith('END'));
  assert.ok(r.text.startsWith('AAAA'));
});

test('所有卡片都是可序列化的 2.0 卡片', () => {
  const all = [
    cards.processingCard({ agent: 'claude', prompt: '改地形' }),
    cards.replyCard({ text: '**完成**', agent: 'claude', cwd: 'D:/x' }),
    cards.screenCard({ text: 'screen text', reason: 'not-ready' }),
    cards.noticeCard({ title: '已停止', text: '会话被关闭' }),
    cards.errorCard({ title: '出错了', text: 'boom' }),
  ];
  for (const c of all) {
    assert.strictEqual(c.schema, '2.0');
    assert.ok(Array.isArray(c.body.elements));
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(c)));
  }
});

test('processingCard 标题含「正在处理」', () => {
  const c = cards.processingCard({ agent: 'codex', prompt: '看看这个 bug' });
  assert.match(c.header.title.content, /正在处理/);
  const json = JSON.stringify(c);
  assert.ok(json.includes('看看这个 bug'));
});

test('replyCard 把正文放进 markdown 元素', () => {
  const c = cards.replyCard({ text: '第一行\n第二行', agent: 'claude', cwd: 'D:/feishu-workspace' });
  const md = c.body.elements.find((e) => e.tag === 'markdown');
  assert.ok(md);
  assert.ok(md.content.includes('第一行\n第二行'));
  assert.ok(JSON.stringify(c).includes('D:/feishu-workspace'));
});

test('screenCard 带「仍然发送」回调按钮', () => {
  const c = cards.screenCard({ text: '当前画面', reason: 'not-ready' });
  const btn = c.body.elements.find((e) => e.tag === 'button');
  assert.ok(btn);
  assert.strictEqual(btn.text.content, '仍然发送');
  assert.deepStrictEqual(btn.behaviors[0].value, { act: 'force-send' });
});

test('errorCard 用红色标题', () => {
  const c = cards.errorCard({ title: '出错了', text: 'x' });
  assert.strictEqual(c.header.template, 'red');
});
