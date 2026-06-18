import fs from 'node:fs';
import path from 'node:path';

/**
 * 项目级文件化长期记忆（对齐 Claude Code 的多层文件化记忆，轻量版）。
 * 结构：
 *   <workdir>/.mca/memory/
 *     ├── MEMORY.md        # 入口索引（只放索引行 + 一行描述）
 *     └── <topic>.md       # 每条记忆单独成文
 * agent 通过现有 read_file / write_file 工具维护本目录（位于沙箱内，天然可写）。
 */

export const MEMORY_SUBDIR = path.join('.mca', 'memory');
export const ENTRYPOINT_NAME = 'MEMORY.md';
export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;

/** 返回项目级长期记忆目录的绝对路径。 */
export function getMemoryDir(workdir: string): string {
  return path.join(workdir, MEMORY_SUBDIR);
}

/**
 * 确保记忆目录与入口文件存在（幂等）。
 * 这样 prompt 中宣称「目录已存在、可直接读写」才成立，
 * 模型用 list_dir / read_file 访问时不会再 ENOENT。
 */
export function ensureMemoryDir(memoryDir: string): void {
  try {
    fs.mkdirSync(memoryDir, { recursive: true });
    const entry = path.join(memoryDir, ENTRYPOINT_NAME);
    if (!fs.existsSync(entry)) {
      fs.writeFileSync(
        entry,
        '# 长期记忆索引\n\n> 每条记忆单独成文（<topic>.md），并在此处登记一行索引。\n',
      );
    }
  } catch {
    /* 创建失败（如只读环境）时静默忽略，prompt 仍可工作。 */
  }
}

/** 对入口内容做硬截断保护（200 行 / 25KB），防止 prompt 膨胀。 */
export function truncateEntrypoint(content: string): {
  content: string;
  truncated: boolean;
} {
  let truncated = false;
  let out = content;

  const lines = out.split('\n');
  if (lines.length > MAX_ENTRYPOINT_LINES) {
    out = lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n');
    truncated = true;
  }
  if (Buffer.byteLength(out, 'utf8') > MAX_ENTRYPOINT_BYTES) {
    // 按字节截断到上限内（保守地按字符回退）。
    while (Buffer.byteLength(out, 'utf8') > MAX_ENTRYPOINT_BYTES && out.length > 0) {
      out = out.slice(0, Math.floor(out.length * 0.9));
    }
    truncated = true;
  }
  return { content: out, truncated };
}

/** 同步读取 MEMORY.md（不存在返回空字符串）。 */
export function readEntrypoint(memoryDir: string): string {
  try {
    return fs.readFileSync(path.join(memoryDir, ENTRYPOINT_NAME), 'utf8');
  } catch {
    return '';
  }
}

/**
 * 构造注入 system prompt 的长期记忆段：
 * - 告知记忆目录与治理规则（双步写入法）
 * - 附上当前 MEMORY.md 索引内容（或「空」提示）
 */
export function buildMemoryPrompt(memoryDir: string): string {
  ensureMemoryDir(memoryDir);
  const normalizedDir = memoryDir.replace(/\\/g, '/');
  const lines: string[] = [
    `长期记忆（持久化于 ${normalizedDir}）：`,
    `你拥有一个基于文件的持久记忆系统，该目录已存在、可直接读写（无需先 list_dir 或 mkdir 确认）。`,
    '记忆治理规则：',
    '- 值得长期记住的内容：用户的长期偏好、项目外部约束、跨会话需延续的决策与结论。',
    '- 不要保存：可从代码直接推导的信息、临时细节、重复内容。',
    '- 双步写入法：先用 `write_file` 把单条记忆写成 `<topic>.md`，再在 `MEMORY.md` 追加一行索引（链接 + 一行描述）。',
    '- 需要回忆细节时，先看 `MEMORY.md` 索引，再用 `read_file` 读取对应 topic 文件。',
  ];

  const raw = readEntrypoint(memoryDir);
  if (raw.trim()) {
    const { content } = truncateEntrypoint(raw);
    lines.push('', `## ${ENTRYPOINT_NAME}`, '', content.trim());
  } else {
    lines.push(
      '',
      `## ${ENTRYPOINT_NAME}`,
      '',
      `当前 ${ENTRYPOINT_NAME} 为空。当你保存新记忆后，它们会出现在这里。`,
    );
  }

  return lines.join('\n');
}
