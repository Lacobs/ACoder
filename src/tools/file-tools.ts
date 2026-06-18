import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Tool } from './types.js';
import { displayPath, resolveSafe } from './safe-path.js';

const DIFF_MAX_LINES = 20;

/** 归一化单行：去掉行首尾空白，用于容错匹配。 */
function normalizeLine(line: string): string {
  return line.trim();
}

/**
 * 在 contentLines 中用滑动窗口寻找「连续 N 行 normalize 后等于 oldLines 各行 normalize」的起始下标。
 * 命中后跳过该窗口，避免重叠匹配。
 */
function findFuzzyMatches(contentLines: string[], oldLines: string[]): number[] {
  const n = oldLines.length;
  if (n === 0) return [];
  const normalizedOld = oldLines.map(normalizeLine);
  const matches: number[] = [];
  let i = 0;
  while (i + n <= contentLines.length) {
    let hit = true;
    for (let j = 0; j < n; j++) {
      if (normalizeLine(contentLines[i + j]) !== normalizedOld[j]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      matches.push(i);
      i += n;
    } else {
      i++;
    }
  }
  return matches;
}

/** 将文本按行截断到 max 行，超出则追加截断标记。 */
function truncateLines(text: string, max: number = DIFF_MAX_LINES): string[] {
  const lines = text.split('\n');
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), '...[已截断]'];
}

/** 构建 edit_file 成功后的变更预览（旧片段 - 前缀，新片段 + 前缀）。 */
function buildDiffPreview(oldSegment: string, newSegment: string): string {
  const oldPart = truncateLines(oldSegment)
    .map((l) => `- ${l}`)
    .join('\n');
  const newPart = truncateLines(newSegment)
    .map((l) => `+ ${l}`)
    .join('\n');
  return `--- 变更预览 ---\n${oldPart}\n${newPart}`;
}

/** 简单的字符多重集相似度（0..1），用于失败诊断时挑选最接近的行。 */
function lineSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of a) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let shared = 0;
  for (const ch of b) {
    const c = counts.get(ch) ?? 0;
    if (c > 0) {
      shared++;
      counts.set(ch, c - 1);
    }
  }
  return shared / Math.max(a.length, b.length);
}

/** 失败诊断：根据 old_string 的锚点行，列出文件中最接近的若干候选行。 */
function buildFailureDiagnostics(contentLines: string[], oldString: string): string {
  const anchorRaw = oldString.split('\n').find((l) => l.trim().length > 0) ?? '';
  const anchor = anchorRaw.trim();
  if (anchor.length === 0) {
    return '未找到要替换的文本，请用 read_file 确认确切内容。';
  }

  type Candidate = { lineNo: number; content: string; score: number };
  const candidates: Candidate[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    const trimmed = contentLines[i].trim();
    if (trimmed.length === 0) continue;
    let score: number;
    if (trimmed.includes(anchor) || anchor.includes(trimmed)) {
      score = 1;
    } else {
      score = lineSimilarity(trimmed, anchor);
    }
    if (score >= 0.5) {
      candidates.push({ lineNo: i + 1, content: contentLines[i], score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 3);
  if (top.length === 0) {
    return '未找到要替换的文本，也未找到相近的候选行，请用 read_file 确认确切内容。';
  }

  const lines = top.map((c) => `  L${c.lineNo}: ${c.content}`).join('\n');
  return `未找到要替换的文本。最接近的候选行如下，请据此修正 old_string（或用 read_file 确认确切内容）：\n${lines}`;
}

/** 轻量行级 diff：逐行对比，列出删除/新增的行，截断控制体积。 */
function buildLineDiff(oldText: string, newText: string, max: number = DIFF_MAX_LINES): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const out: string[] = [];
  const total = Math.max(oldLines.length, newLines.length);
  let shown = 0;
  for (let i = 0; i < total; i++) {
    if (shown >= max) {
      out.push('...[已截断]');
      break;
    }
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) continue;
    if (o !== undefined) {
      out.push(`- ${o}`);
      shown++;
    }
    if (n !== undefined && shown < max) {
      out.push(`+ ${n}`);
      shown++;
    }
  }
  if (out.length === 0) return '（内容无逐行差异）';
  return out.join('\n');
}

export const readFileTool: Tool = {
  name: 'read_file',
  description: '读取工作目录内某个文本文件的内容，按行分页并带行号输出。',
  parameters: z.object({
    path: z.string().describe('相对工作目录的文件路径'),
    offset: z.number().int().positive().optional().describe('起始行号（1 基，默认 1）'),
    limit: z.number().int().positive().optional().describe('读取行数（默认 400）'),
  }),
  async execute(args: { path: string; offset?: number; limit?: number }, ctx) {
    const abs = resolveSafe(ctx.workdir, args.path);
    const content = await fs.readFile(abs, 'utf8');
    const lines = content.split('\n');
    const totalLines = lines.length;

    const offset = args.offset ?? 1;
    const limit = args.limit ?? 400;

    const startIdx = offset - 1;
    const endIdx = Math.min(startIdx + limit, totalLines);
    const selected = startIdx < totalLines ? lines.slice(startIdx, endIdx) : [];

    const width = String(endIdx).length;
    const numbered = selected
      .map((line, i) => {
        const lineNo = String(offset + i).padStart(width, ' ');
        return `${lineNo}→${line}`;
      })
      .join('\n');

    const firstShown = selected.length > 0 ? offset : 0;
    const lastShown = selected.length > 0 ? offset + selected.length - 1 : 0;
    const header = `文件 ${displayPath(ctx.workdir, abs)}（共 ${totalLines} 行，显示 ${firstShown}-${lastShown} 行）:`;

    const remaining = totalLines - endIdx;
    const footer = remaining > 0 ? `\n...[还有 ${remaining} 行，使用 offset=${endIdx + 1} 继续读取]` : '';

    return {
      ok: true,
      output: `${header}\n${numbered}${footer}`,
      data: { path: args.path, totalLines, offset, limit },
    };
  },
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    '将内容整文件覆盖写入工作目录内的文件（自动创建父目录）。注意：会覆盖整个文件，修改已有文件前务必先 read_file 获取完整内容，或优先使用 edit_file 做局部修改，否则会丢失未包含的代码。',
  parameters: z.object({
    path: z.string().describe('相对工作目录的文件路径'),
    content: z.string().describe('要写入的文本内容'),
  }),
  async execute(args: { path: string; content: string }, ctx) {
    const abs = resolveSafe(ctx.workdir, args.path);
    const dir = path.dirname(abs);
    if (dir) await fs.mkdir(dir, { recursive: true });

    let oldContent: string | null = null;
    try {
      oldContent = await fs.readFile(abs, 'utf8');
    } catch {
      oldContent = null;
    }

    await fs.writeFile(abs, args.content, 'utf8');

    const shown = displayPath(ctx.workdir, abs);
    if (oldContent === null) {
      return {
        ok: true,
        output: `已新建文件 ${shown}（${args.content.length} 字符）。`,
        data: { path: args.path, bytes: Buffer.byteLength(args.content) },
      };
    }

    const oldLineCount = oldContent.split('\n').length;
    const newLineCount = args.content.split('\n').length;
    const diff = buildLineDiff(oldContent, args.content);
    return {
      ok: true,
      output:
        `已覆盖写入 ${shown}（${args.content.length} 字符）。\n` +
        `旧 ${oldLineCount} 行 → 新 ${newLineCount} 行。\n` +
        `--- 变更摘要 ---\n${diff}`,
      data: { path: args.path, bytes: Buffer.byteLength(args.content) },
    };
  },
};

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    '对工作目录内已有文件做精确局部替换（old_string→new_string），仅改动匹配片段，避免整文件覆盖。修改前应先用 read_file 确认要替换的确切文本。',
  parameters: z.object({
    path: z.string().describe('相对工作目录的文件路径'),
    old_string: z.string().describe('要被替换的确切文本'),
    new_string: z.string().describe('替换后的文本'),
    replace_all: z.boolean().optional().describe('是否替换所有匹配项（默认 false）'),
  }),
  async execute(
    args: { path: string; old_string: string; new_string: string; replace_all?: boolean },
    ctx,
  ) {
    const abs = resolveSafe(ctx.workdir, args.path);
    const replaceAll = args.replace_all ?? false;

    if (args.old_string === args.new_string) {
      return {
        ok: false,
        output: 'old_string 与 new_string 相同，无变化。',
        data: { path: args.path, replacements: 0 },
      };
    }

    const content = await fs.readFile(abs, 'utf8');
    const occurrences = content.split(args.old_string).length - 1;
    const shown = displayPath(ctx.workdir, abs);

    if (occurrences === 0) {
      // 退化匹配：忽略每行行首/行尾空白差异。
      const contentLines = content.split('\n');
      const oldLines = args.old_string.split('\n');
      const fuzzyMatches = findFuzzyMatches(contentLines, oldLines);

      if (fuzzyMatches.length === 0) {
        return {
          ok: false,
          output: buildFailureDiagnostics(contentLines, args.old_string),
          data: { path: args.path, replacements: 0 },
        };
      }

      if (!replaceAll && fuzzyMatches.length > 1) {
        return {
          ok: false,
          output: `old_string（容错匹配）命中 ${fuzzyMatches.length} 处，不唯一；请补充更多上下文使其唯一，或设置 replace_all=true。`,
          data: { path: args.path, replacements: 0 },
        };
      }

      const n = oldLines.length;
      const targets = replaceAll ? fuzzyMatches : [fuzzyMatches[0]];
      // 从后往前替换，避免下标偏移。
      const sorted = [...targets].sort((a, b) => b - a);
      let firstOldSegment = '';
      for (const start of sorted) {
        const segment = contentLines.slice(start, start + n).join('\n');
        firstOldSegment = segment;
        contentLines.splice(start, n, ...args.new_string.split('\n'));
      }
      const updatedFuzzy = contentLines.join('\n');
      await fs.writeFile(abs, updatedFuzzy, 'utf8');

      const replacementsFuzzy = targets.length;
      const preview = buildDiffPreview(firstOldSegment, args.new_string);
      return {
        ok: true,
        output: `已在 ${shown} 替换 ${replacementsFuzzy} 处（容错匹配，忽略行首尾空白差异）。\n${preview}`,
        data: { path: args.path, replacements: replacementsFuzzy },
      };
    }

    if (!replaceAll && occurrences > 1) {
      return {
        ok: false,
        output: `old_string 匹配到 ${occurrences} 处，不唯一；请补充更多上下文使其唯一，或设置 replace_all=true。`,
        data: { path: args.path, replacements: 0 },
      };
    }

    let updated: string;
    let replacements: number;
    if (replaceAll) {
      updated = content.split(args.old_string).join(args.new_string);
      replacements = occurrences;
    } else {
      const idx = content.indexOf(args.old_string);
      updated = content.slice(0, idx) + args.new_string + content.slice(idx + args.old_string.length);
      replacements = 1;
    }

    await fs.writeFile(abs, updated, 'utf8');
    const preview = buildDiffPreview(args.old_string, args.new_string);
    return {
      ok: true,
      output: `已在 ${shown} 替换 ${replacements} 处。\n${preview}`,
      data: { path: args.path, replacements },
    };
  },
};
