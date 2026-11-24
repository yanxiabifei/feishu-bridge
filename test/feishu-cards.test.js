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

test('所有卡片的 config 不含 wide_screen_mode，且含 update_multi: true', () => {
  const all = [
    cards.processingCard({ agent: 'claude', prompt: '改地形' }),
    cards.replyCard({ text: '**完成**', agent: 'claude', cwd: 'D:/x' }),
    cards.screenCard({ text: 'screen text', reason: 'not-ready' }),
    cards.noticeCard({ title: '已停止', text: '会话被关闭' }),
    cards.errorCard({ title: '出错了', text: 'boom' }),
  ];
  for (const c of all) {
    assert.strictEqual(c.config.update_multi, true);
    assert.ok(!('wide_screen_mode' in c.config));
  }
});

test('动态文本中的 <at> 标签被转义', () => {
  const injected = '<at id=all></at> 你好';
  const all = [
    cards.processingCard({ prompt: injected }),
    cards.replyCard({ text: injected }),
    cards.noticeCard({ title: '通知', text: injected }),
    cards.errorCard({ title: '错误', text: injected }),
  ];
  for (const c of all) {
    const json = JSON.stringify(c);
    assert.ok(!json.includes('<at'), '不得出现原始 <at 标签');
    assert.ok(json.includes('&#60;at'), '应转义为 &#60;at');
  }
});

test('note 保留我们的 <font> 包裹，同时转义 footer 动态内容', () => {
  const c = cards.replyCard({ text: 'x'.repeat(9000), agent: 'claude', cwd: '<at id=all></at>' });
  const notes = c.body.elements.filter((e) => e.tag === 'markdown' && e.content.includes("<font color='grey'>"));
  assert.ok(notes.length >= 1);
  for (const el of notes) {
    assert.ok(el.content.startsWith("<font color='grey'>"));
    assert.ok(el.content.endsWith('</font>'));
  }
  const json = JSON.stringify(c);
  assert.ok(!json.includes('<at'));
  assert.ok(json.includes('&#60;at'));
  assert.ok(json.includes("<font color='grey'>Claude"));
});

test('screenCard 围栏内容里的 ``` 被零宽空格打断', () => {
  const c = cards.screenCard({ text: 'a\n```\n<at id=all></at>\n```\nb' });
  const el = c.body.elements.find((e) => e.tag === 'markdown' && e.content.startsWith('```'));
  assert.ok(el);
  const lines = el.content.split('\n');
  assert.strictEqual(lines[0], '```');
  assert.strictEqual(lines[lines.length - 1], '```');
  assert.strictEqual(lines.filter((l) => l === '```').length, 2);
  const inner = lines.slice(1, -1).join('\n');
  assert.ok(!inner.includes('```'), '围栏内部不得出现未打断的连续三反引号');
  assert.ok(el.content.includes('\u200B'), '应有零宽空格打断围栏');
  assert.ok(!el.content.includes('<at'));
  assert.ok(el.content.includes('&#60;at'));
});

test('truncate：limit 小于 TAIL_CHARS 时不越截越长', () => {
  const src = 'x'.repeat(1400);
  const r = cards.truncate(src, 1000);
  assert.strictEqual(r.truncated, true);
  assert.ok(r.text.length <= src.length);
  assert.ok(r.text.includes('完整内容请到电脑上看'));
});

test('truncate：恰好等于 limit 时不截断', () => {
  const src = 'x'.repeat(1000);
  assert.deepStrictEqual(cards.truncate(src, 1000), { text: src, truncated: false });
});

test('truncate：非字符串输入不抛错', () => {
  assert.doesNotThrow(() => cards.truncate(null));
  assert.doesNotThrow(() => cards.truncate(123));
  assert.strictEqual(cards.truncate(null).text, '');
  assert.strictEqual(cards.truncate(123).text, '123');
});

test('screenOutputCard：引导行 + 代码块 + 查看完整画面按钮', () => {
  const c = cards.screenOutputCard({
    lead: '🖥 你刚在电脑上问：写个快排',
    text: 'def quicksort():\n    pass',
    agent: 'codex',
    cwd: 'D:/x',
  });
  const body = JSON.stringify(c.body);
  assert.ok(body.includes('你刚在电脑上问'));
  assert.ok(body.includes('def quicksort'));
  const btn = c.body.elements.find((e) => e.tag === 'button');
  assert.deepStrictEqual(btn.behaviors[0].value, { act: 'full-screen', lines: 200 });
});

test('screenOutputCard：超长画面截断', () => {
  const c = cards.screenOutputCard({ text: 'x'.repeat(9000) });
  assert.ok(JSON.stringify(c.body).includes('已截断'));
});

test('fullScreenCard：标题带行数，正文带画面', () => {
  const c = cards.fullScreenCard({ text: '第 1 行\n第 200 行', lines: 200 });
  assert.ok(c.header.title.content.includes('200'));
  assert.ok(JSON.stringify(c.body).includes('第 200 行'));
});

test('screenOutputCard：围栏内容里的 ``` 被打断且 <at> 被转义', () => {
  const c = cards.screenOutputCard({ text: '正常\n```\n<at id=all></at>\n```\n尾' });
  const json = JSON.stringify(c.body);
  assert.ok(!json.includes('<at '), '不得出现未转义的 <at');
  assert.ok(json.includes('&#60;at'), '应转义为 &#60;at');
  const el = c.body.elements.find((e) => e.tag === 'markdown' && e.content.startsWith('```'));
  assert.ok(el);
  const lines = el.content.split('\n');
  assert.strictEqual(lines.filter((l) => l === '```').length, 2);
  assert.ok(el.content.includes(String.fromCharCode(0x200b)), '应有零宽空格打断围栏');
});

test('screenOutputCard：lead 里的 <at> 被转义', () => {
  const c = cards.screenOutputCard({
    lead: '🖥 你刚在电脑上问：<at id=all></at>',
    text: '画面',
  });
  const json = JSON.stringify(c.body);
  assert.ok(!json.includes('<at '), '不得出现未转义的 <at');
  assert.ok(json.includes('&#60;at'), '应转义为 &#60;at');
});

test('fullScreenCard：围栏内容里的 ``` 被打断且 <at> 被转义', () => {
  const c = cards.fullScreenCard({ text: 'a\n```\n<at id=all></at>\n```\nb', lines: 200 });
  const json = JSON.stringify(c.body);
  assert.ok(!json.includes('<at '), '不得出现未转义的 <at');
  assert.ok(json.includes('&#60;at'), '应转义为 &#60;at');
  const el = c.body.elements.find((e) => e.tag === 'markdown' && e.content.startsWith('```'));
  assert.ok(el);
  const lines = el.content.split('\n');
  assert.strictEqual(lines.filter((l) => l === '```').length, 2);
  assert.ok(el.content.includes(String.fromCharCode(0x200b)), '应有零宽空格打断围栏');
});
