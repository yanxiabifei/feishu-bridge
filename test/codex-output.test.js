const test = require('node:test');
const assert = require('node:assert');
const { cleanCodexSnapshot } = require('../src/session/codexOutput');

// Codex TUI 的输入框是屏幕最后一条以 › 开头的行（空框显示占位符
// "› Ask Codex to do anything"），框下只有 model/目录和 "? for shortcuts" 页脚。
// 这些尾巴混进「Codex 输出」卡片后看起来像正文，推送前要切掉。

test('cleanCodexSnapshot：切掉最后一条 › 输入框行及其下方页脚', () => {
  const raw = [
    '› 写个快排',
    '• 好的，这是快排：',
    '  def quicksort(x):',
    '      return x',
    '› Ask Codex to do anything',
    'gpt-5.1-codex high · D:/code',
    '? for shortcuts',
  ].join('\n');

  assert.strictEqual(cleanCodexSnapshot(raw), [
    '› 写个快排',
    '• 好的，这是快排：',
    '  def quicksort(x):',
    '      return x',
  ].join('\n'));
});

test('cleanCodexSnapshot：空草稿（只有提示符）也切掉', () => {
  const raw = '• done\n› \nmodel · dir\n? for shortcuts';
  assert.strictEqual(cleanCodexSnapshot(raw), '• done');
});

test('cleanCodexSnapshot：没有输入框时保留正文，只折叠连续空行', () => {
  const raw = '\n\n• 第一段\n\n\n\n• 第二段   \n\n';
  assert.strictEqual(cleanCodexSnapshot(raw), '• 第一段\n\n• 第二段');
});

test('cleanCodexSnapshot：空输入不抛错', () => {
  assert.strictEqual(cleanCodexSnapshot(''), '');
  assert.strictEqual(cleanCodexSnapshot(null), '');
  assert.strictEqual(cleanCodexSnapshot(undefined), '');
});

test('cleanCodexSnapshot：CRLF 换行同样处理', () => {
  const raw = '• ok\r\n› Ask Codex to do anything\r\n? for shortcuts\r\n';
  assert.strictEqual(cleanCodexSnapshot(raw), '• ok');
});
