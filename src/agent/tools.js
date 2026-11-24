// src/agent/tools.js
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const MAX_TYPES = 3;

// 从 transcript JSONL 的末尾倒着扫，统计「最后一轮」的工具调用；
// 碰到 user 消息就停（那是这一轮的开始）。
function summarizeToolUse(jsonlText) {
  const lines = String(jsonlText || '').split('\n');
  const counts = new Map();
  const files = new Set();

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'user') break;
    if (entry.type !== 'assistant') continue;

    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use' || !block.name) continue;
      counts.set(block.name, (counts.get(block.name) || 0) + 1);
      if (FILE_TOOLS.has(block.name) && block.input && typeof block.input.file_path === 'string') {
        files.add(block.input.file_path);
      }
    }
  }

  const parts = [];
  if (files.size > 0) parts.push(`改了 ${files.size} 个文件`);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TYPES);
  for (const [name, n] of top) parts.push(`${name}×${n}`);
  return parts.length ? `🔧 ${parts.join(' · ')}` : '';
}

module.exports = { summarizeToolUse };
