const test = require('node:test');
const assert = require('node:assert');
const { parseMessage, parseCardAction, parseChatId } = require('../src/feishu/events');

function evt(over = {}, msgOver = {}) {
  return {
    event_id: 'ev_1',
    sender: { sender_id: { open_id: 'ou_me' }, sender_type: 'user' },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: '{"text":"你好"}',
      ...msgOver,
    },
    ...over,
  };
}

test('解析文本消息的基本字段', () => {
  const m = parseMessage(evt());
  assert.deepStrictEqual(m, {
    chatId: 'oc_1', chatType: 'p2p', messageId: 'om_1', openId: 'ou_me',
    senderType: 'user', text: '你好', media: null, mentioned: false, unsupported: null,
  });
});

test('剥离 @_user_N 占位符并标记 mentioned', () => {
  const m = parseMessage(evt({}, {
    chat_type: 'group',
    content: '{"text":"@_user_1 看看这个"}',
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '桥' }],
  }));
  assert.strictEqual(m.text, '看看这个');
  assert.strictEqual(m.mentioned, true);
  assert.strictEqual(m.chatType, 'group');
});

test('富文本 post 拉平为带标题的文本', () => {
  const content = JSON.stringify({
    title: '标题',
    content: [
      [{ tag: 'text', text: '第一段' }, { tag: 'at', user_id: '@_user_1', user_name: '桥' }],
      [{ tag: 'text', text: '第二段' }],
    ],
  });
  const m = parseMessage(evt({}, { message_type: 'post', content, mentions: [{ key: '@_user_1', name: '桥' }] }));
  assert.strictEqual(m.text, '标题\n第一段@桥\n第二段');
  assert.strictEqual(m.mentioned, true);
});

test('图片消息解析出 media', () => {
  const m = parseMessage(evt({}, { message_type: 'image', content: '{"image_key":"img_1"}' }));
  assert.deepStrictEqual(m.media, { messageId: 'om_1', fileKey: 'img_1', type: 'image', fileName: 'om_1.png' });
  assert.strictEqual(m.text, '');
});

test('文件消息保留原始文件名', () => {
  const m = parseMessage(evt({}, { message_type: 'file', content: '{"file_key":"file_1","file_name":"需求.md"}' }));
  assert.deepStrictEqual(m.media, { messageId: 'om_1', fileKey: 'file_1', type: 'file', fileName: '需求.md' });
});

test('机器人自己发的消息返回 null（防回环）', () => {
  assert.strictEqual(parseMessage(evt({ sender: { sender_id: { open_id: 'ou_bot' }, sender_type: 'app' } })), null);
});

test('无法解析的 content 与空载荷不抛异常', () => {
  const m = parseMessage(evt({}, { content: '{坏' }));
  assert.strictEqual(m.text, '');
  assert.strictEqual(parseMessage({}), null);
});

test('不支持的类型放进 unsupported', () => {
  const m = parseMessage(evt({}, { message_type: 'audio', content: '{"file_key":"a_1"}' }));
  assert.strictEqual(m.unsupported, 'audio');
  assert.strictEqual(m.media, null);
});

test('卡片动作从 context.open_chat_id 取群，缺字段返回 null', () => {
  const a = parseCardAction({
    operator: { open_id: 'ou_me' },
    action: { value: { act: 'send', sessionId: 's_1' } },
    context: { open_chat_id: 'oc_1' },
  });
  assert.deepStrictEqual(a, {
    chatId: 'oc_1', openId: 'ou_me', action: { act: 'send', sessionId: 's_1' },
  });
  assert.strictEqual(parseCardAction({ operator: { open_id: 'ou_me' }, action: { value: { act: 'send' } } }), null);
  assert.strictEqual(parseCardAction({ context: { open_chat_id: 'oc_1' }, action: { value: {} } }), null);
});

test('parseChatId 兼容两种群事件载荷', () => {
  assert.strictEqual(parseChatId({ chat_id: 'oc_1' }), 'oc_1');
  assert.strictEqual(parseChatId({ chat: { chat_id: 'oc_2' } }), 'oc_2');
  assert.strictEqual(parseChatId({ message: { chat_id: 'oc_3' } }), 'oc_3');
  assert.strictEqual(parseChatId({}), '');
});
