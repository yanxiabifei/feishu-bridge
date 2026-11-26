// 验收第 11 条：日志里不许出现 App Secret / API token。
const fs = require('node:fs');
const path = require('node:path');
const paths = require('../src/paths');
const { createSecretStore } = require('../src/secrets');

// 太短的串（<8 字符）不参与匹配，避免空串/常见词造成假阳性
const MIN_NEEDLE = 8;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    // 软链接可能指回父目录或指向特殊设备，不跟随，避免成环 / EISDIR
    if (e.isSymbolicLink()) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

function effectiveNeedles(needles) {
  return (needles || []).filter((n) => typeof n === 'string' && n.length >= MIN_NEEDLE);
}

// 读不了一律抛错，由调用方按「失败」处理，不能当成「没命中」
function scanFiles(files, needles) {
  const list = effectiveNeedles(needles);
  if (list.length === 0) return [];
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`无法读取 ${file}：${err.message}`);
    }
    if (list.some((n) => text.includes(n))) hits.push(file);
  }
  return hits;
}

function scan(dir, needles) {
  return scanFiles(walk(dir), needles);
}

function main() {
  const needles = [];
  let secret;
  try {
    secret = createSecretStore({ file: paths.SECRET }).load();
  } catch (err) {
    // 凭据文件坏了 / DPAPI 解不开：这项没法校验，直接失败，不能假装通过
    console.error(`无法读取凭据，无法校验 App Secret：${err.message}`);
    process.exit(2);
  }
  if (secret) needles.push(secret);
  if (process.env.ANTHROPIC_AUTH_TOKEN) needles.push(process.env.ANTHROPIC_AUTH_TOKEN);

  if (effectiveNeedles(needles).length === 0) {
    // 没有任何可用来搜的凭据：跳过，且明确「不算通过」
    console.log('跳过：未配置凭据，无法校验 App Secret（此项不算通过）');
    return;
  }

  const files = walk(paths.LOGS);
  let hits;
  try {
    hits = scanFiles(files, needles);
  } catch (err) {
    console.error(`失败：${err.message}`);
    process.exit(1);
  }
  if (hits.length > 0) {
    console.log(`失败：以下日志含机密\n${hits.join('\n')}`);
    process.exit(1);
  }
  console.log(`OK：扫描 ${files.length} 个日志文件，未发现机密`);
}

module.exports = { scan, scanFiles, walk };

if (require.main === module) main();
