import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Tool } from './types.js';
import { resolveSafe, displayPath } from './safe-path.js';

/**
 * patch(1) 风格的统一 diff 应用工具。
 * 支持格式：
 *   *** Begin Patch
 *   *** Update File: <filepath>
 *   @@ ... @@
 *   -old line
 *   +new line
 *   *** End Patch
 *
 * 多个 *** Update File 块可在一个 patch 中串行。
 */
interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: { type: 'context' | 'remove' | 'add'; content: string }[];
}

function parsePatch(patch: string): { file: string; hunks: Hunk[] }[] {
  const files: { file: string; hunks: Hunk[] }[] = [];

  // 切分 *** Update File 块
  const fileBlocks = patch.split(/(?=^\*\*\* Update File:)/m);
  for (const block of fileBlocks) {
    const headerMatch = block.match(/^\*\*\* Update File:\s*(.+?)\s*$/m);
    if (!headerMatch) continue;
    const filePath = headerMatch[1].trim();

    const hunks: Hunk[] = [];
    // 查找所有 @@ ... @@ 段落
    const hunkRegex = /@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@([\s\S]*?)(?=@@|\*\*\*|$)/g;
    let hunkMatch;
    while ((hunkMatch = hunkRegex.exec(block)) !== null) {
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
      const body = hunkMatch[5];

      const lines: Hunk['lines'] = [];
      for (const rawLine of body.split('\n')) {
        if (rawLine.startsWith('-')) {
          lines.push({ type: 'remove', content: rawLine.slice(1) });
        } else if (rawLine.startsWith('+')) {
          lines.push({ type: 'add', content: rawLine.slice(1) });
        } else if (rawLine.startsWith(' ') || rawLine === '') {
          lines.push({ type: 'context', content: rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine });
        }
      }

      if (lines.length > 0) {
        hunks.push({ oldStart, oldCount, newStart, newCount, lines });
      }
    }

    if (hunks.length > 0) {
      files.push({ file: filePath, hunks });
    }
  }

  return files;
}

function applyHunks(originalLines: string[], hunks: Hunk[]): { lines: string[]; errors: string[] } {
  const errors: string[] = [];
  let result = [...originalLines];
  // 从后往前应用，避免行号偏移
  const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of sorted) {
    const oldIdx = hunk.oldStart - 1; // 0-based
    const contextLines = hunk.lines.filter((l) => l.type === 'context');
    const removeLines = hunk.lines.filter((l) => l.type === 'remove');

    // 用上下文行定位精确位置（容错匹配）
    let bestIdx = oldIdx;
    let bestScore = 0;
    const searchWindow = 10;

    for (let offset = -searchWindow; offset <= searchWindow; offset++) {
      const candidateIdx = oldIdx + offset;
      if (candidateIdx < 0 || candidateIdx >= result.length) continue;
      let score = 0;
      for (let i = 0; i < contextLines.length; i++) {
        const targetLine = result[candidateIdx + i];
        if (targetLine !== undefined && targetLine.trim() === contextLines[i].content.trim()) {
          score++;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = candidateIdx;
      }
    }

    // 生成新行：context/add 行
    const newBlock: string[] = [];
    for (const line of hunk.lines) {
      if (line.type === 'context' || line.type === 'add') {
        newBlock.push(line.content);
      }
      // remove 行被跳过
    }

    const removeCount = removeLines.length + contextLines.length;
    result = [...result.slice(0, bestIdx), ...newBlock, ...result.slice(bestIdx + removeCount)];
  }

  return { lines: result, errors };
}

function buildDiffSummary(original: string[], patched: string[], hunkCount: number): string {
  const diffLines: string[] = [];
  let addedTotal = 0;
  let removedTotal = 0;

  // Simple line-by-line diff for summary
  const maxLen = Math.max(original.length, patched.length);
  for (let i = 0; i < maxLen; i++) {
    const o = original[i];
    const p = patched[i];
    if (o !== p) {
      if (o !== undefined && p === undefined) {
        diffLines.push(`- ${o}`);
        removedTotal++;
      } else if (o === undefined && p !== undefined) {
        diffLines.push(`+ ${p}`);
        addedTotal++;
      } else {
        diffLines.push(`- ${o}`);
        diffLines.push(`+ ${p}`);
        removedTotal++;
        addedTotal++;
      }
    }
    if (diffLines.length > 20) break;
  }

  if (diffLines.length === 0) {
    diffLines.push('  (无实际变更)');
  }

  const summary = `应用 ${hunkCount} 个 hunk：+${addedTotal} 行 / -${removedTotal} 行`;
  return [summary, '--- 变更预览 ---', ...diffLines].join('\n');
}

export const applyPatchTool: Tool = {
  name: 'apply_patch',
  description:
    '应用 patch 格式的代码修改。支持统一 diff 风格的多文件、多 hunk 补丁。格式：*** Begin Patch\\n*** Update File: <path>\\n@@ -L,C +L,C @@\\n-旧行\\n+新行\\n*** End Patch',
  parameters: z.object({
    patch: z.string().describe('完整的 patch 内容（多文件用多个 *** Update File 块）'),
  }),
  async execute(args, ctx) {
    if (!args.patch || !args.patch.trim()) {
      return { ok: false, output: 'patch 内容为空。' };
    }

    const filePatches = parsePatch(args.patch);
    if (filePatches.length === 0) {
      return { ok: false, output: '未找到有效的 patch 块。请使用格式：*** Begin Patch\\n*** Update File: <path>\\n@@ ... @@\\n*** End Patch' };
    }

    const results: string[] = [];
    let totalHunks = 0;
    let totalFiles = 0;

    for (const { file: filePath, hunks } of filePatches) {
      let absPath: string;
      try {
        absPath = resolveSafe(ctx.workdir, filePath);
      } catch (err) {
        results.push(`✗ ${filePath}: 路径越界（${err instanceof Error ? err.message : String(err)}）`);
        continue;
      }

      try {
        const original = fs.readFileSync(absPath, 'utf8').split('\n');
        // 去掉末尾空行（split 产生的）
        if (original.length > 0 && original[original.length - 1] === '') original.pop();

        const { lines: patched, errors } = applyHunks(original, hunks);

        if (errors.length > 0) {
          results.push(`✗ ${displayPath(ctx.workdir, absPath)}: ${errors.join('; ')}`);
          continue;
        }

        const newContent = patched.join('\n') + '\n';
        fs.writeFileSync(absPath, newContent, 'utf8');

        const diffSummary = buildDiffSummary(original, patched, hunks.length);
        results.push(`✓ ${displayPath(ctx.workdir, absPath)}`);
        results.push(diffSummary);

        totalHunks += hunks.length;
        totalFiles++;
      } catch (err) {
        results.push(`✗ ${displayPath(ctx.workdir, absPath)}: 读取/写入失败（${err instanceof Error ? err.message : String(err)}）`);
      }
    }

    if (totalFiles === 0) {
      return { ok: false, output: results.join('\n') };
    }

    return {
      ok: true,
      output: `已修改 ${totalFiles} 个文件（${totalHunks} 个 hunk）：\n\n${results.join('\n')}`,
      data: { filesChanged: totalFiles, hunksApplied: totalHunks },
    };
  },
};
