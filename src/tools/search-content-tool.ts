import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Tool } from './types.js';
import { resolveSafe, displayPath } from './safe-path.js';

const MAX_RESULTS = 40;
const MAX_FILE_SIZE = 500_000; // 500KB per file
const CONTEXT_LINES = 2;

async function walkDir(dir: string, include: RegExp | null, exclude: RegExp | null, results: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(dir, abs);
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      await walkDir(abs, include, exclude, results);
    } else if (e.isFile()) {
      if (exclude && exclude.test(rel)) continue;
      if (include && !include.test(rel)) continue;
      results.push(abs);
    }
  }
}

export const searchContentTool: Tool = {
  name: 'search_content',
  description:
    '在工作目录中搜索匹配文本/正则的内容（类 grep）。返回文件名、行号与上下文行。支持 include/exclude 模式过滤文件。',
  parameters: z.object({
    pattern: z.string().describe('搜索模式（字面字符串或正则表达式）'),
    path: z.string().default('.').describe('搜索起始目录，默认工作目录根'),
    regex: z.boolean().default(false).describe('是否将 pattern 作为正则表达式'),
    ignoreCase: z.boolean().default(false).describe('是否忽略大小写'),
    include: z.string().optional().describe('仅搜索匹配此 glob 模式的文件（如 "*.ts" 或 "src/**/*.ts"，用 / 分隔）'),
    exclude: z.string().optional().describe('排除匹配此 glob 模式的文件（如 "*.test.ts" 或 "node_modules/**"）'),
    contextLines: z.number().default(2).describe('每条命中前后展示的上下文行数（0-5）'),
  }),
  async execute(args, ctx) {
    const root = resolveSafe(ctx.workdir, args.path || '.');

    // 构建 include/exclude 正则
    function globToRegex(pattern: string): RegExp {
      let p = pattern.replace(/\./g, '\\.').replace(/\*\*/g, '<<<GLOBSTAR>>>').replace(/\*/g, '[^/]*').replace(/<<<GLOBSTAR>>>/g, '.*');
      return new RegExp(`^${p}$`);
    }
    const includeRe = args.include ? globToRegex(args.include) : null;
    const excludeRe = args.exclude ? globToRegex(args.exclude) : null;

    // 收集文件
    const files: string[] = [];
    const stat = await fs.stat(root).catch(() => null);
    if (!stat) return { ok: false, output: `路径不存在: ${args.path}` };
    if (stat.isDirectory()) {
      await walkDir(root, includeRe, excludeRe, files);
    } else {
      files.push(root);
    }

    // 构建内容匹配器
    let matcher: (line: string) => boolean;
    if (args.regex) {
      let re: RegExp;
      try {
        re = new RegExp(args.pattern, args.ignoreCase ? 'i' : '');
      } catch (err) {
        return { ok: false, output: `正则表达式非法: ${err instanceof Error ? err.message : String(err)}` };
      }
      matcher = (line) => re.test(line);
    } else if (args.ignoreCase) {
      const lower = args.pattern.toLowerCase();
      matcher = (line) => line.toLowerCase().includes(lower);
    } else {
      matcher = (line) => line.includes(args.pattern);
    }

    const ctxLines = Math.max(0, Math.min(5, args.contextLines));
    let totalMatches = 0;
    const outputLines: string[] = [];

    for (const file of files) {
      if (totalMatches >= MAX_RESULTS) break;
      let content: string;
      try {
        const info = fsSync.statSync(file);
        if (info.size > MAX_FILE_SIZE) continue;
        content = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      const relPath = path.relative(ctx.workdir, file);
      const fileMatches: number[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (matcher(lines[i])) {
          fileMatches.push(i);
          totalMatches++;
          if (totalMatches >= MAX_RESULTS) break;
        }
      }

      if (fileMatches.length === 0) continue;

      // 合并重叠的上下文区间
      const ranges: [number, number][] = [];
      for (const idx of fileMatches) {
        const start = Math.max(0, idx - ctxLines);
        const end = Math.min(lines.length - 1, idx + ctxLines);
        if (ranges.length > 0) {
          const last = ranges[ranges.length - 1];
          if (start <= last[1] + 1) {
            last[1] = Math.max(last[1], end);
            continue;
          }
        }
        ranges.push([start, end]);
      }

      const blocks: string[] = [];
      for (const [s, e] of ranges) {
        const block: string[] = [];
        for (let i = s; i <= e; i++) {
          const marker = fileMatches.includes(i) ? '>' : ' ';
          const lineNum = String(i + 1).padStart(4, ' ');
          block.push(`${marker}${lineNum}| ${lines[i].slice(0, 200)}`);
        }
        blocks.push(block.join('\n'));
      }
      outputLines.push(`${relPath}  [${fileMatches.length} 处命中]`);
      outputLines.push(blocks.join('\n---\n'));
    }

    if (outputLines.length === 0) {
      return { ok: true, output: `在 ${files.length} 个文件中未找到匹配 "${args.pattern}" 的内容。` };
    }

    const summary = `搜索 "${args.pattern}"：扫描 ${files.length} 个文件，共 ${totalMatches} 处命中。`;
    outputLines.unshift(summary);

    return {
      ok: true,
      output: outputLines.join('\n'),
      data: { filesScanned: files.length, totalMatches },
    };
  },
};
