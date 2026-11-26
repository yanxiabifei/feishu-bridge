const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scan, scanFiles } = require('../scripts/check-logs');

test('scan：命中机密时返回文件路径，干净目录与不存在的目录返回空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-logs-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.log'), 'hello\nsec_123456\n');
    fs.writeFileSync(path.join(dir, 'clean.log'), 'nothing here\n');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b.log'), 'token=tok_abcdefgh\n');

    assert.deepStrictEqual(scan(dir, ['sec_123456']), [path.join(dir, 'a.log')]);
    assert.deepStrictEqual(scan(dir, ['not-here-at-all']), []);
    assert.deepStrictEqual(scan(path.join(dir, 'nope'), ['sec_123456']), []);

    // 7 字符的串不参与匹配（防止把常见短串当机密）
    assert.deepStrictEqual(scan(dir, ['sec_123']), []);
    // 空串不算命中，否则任何文件都会被判为含机密
    assert.deepStrictEqual(scan(dir, ['']), []);
    // 子目录里的日志也要扫到
    assert.deepStrictEqual(scan(dir, ['tok_abcdefgh']), [path.join(dir, 'sub', 'b.log')]);

    // 读不了的文件必须抛错（失败关闭），不能悄悄当成「没命中」
    assert.throws(() => scanFiles([dir], ['sec_123456']), /无法读取/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
