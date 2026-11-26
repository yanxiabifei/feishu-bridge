const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { ensureDirs, STATE, LOGS, HOOKS, MEDIA } = require('../src/paths');

test('解构调用 ensureDirs 不抛异常，并创建四个运行时目录', () => {
  assert.doesNotThrow(() => ensureDirs());
  for (const d of [STATE, LOGS, HOOKS, MEDIA]) {
    assert.ok(fs.existsSync(d), `目录应存在: ${d}`);
  }
});
