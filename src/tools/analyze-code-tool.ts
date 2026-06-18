import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Tool } from './types.js';
import { resolveSafe } from './safe-path.js';

const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.json', '.md', '.txt',
]);
const SKIP_DIR = new Set(['node_modules', 'dist', '.git', '.idea', '.vscode']);
const CONTEXT_LINES = 2;
const MAX_BLOCKS = 8;

interface Match {
  file: string;
  line: number;
  text: string;
  lines: string[];
  index: number;
}

async function walk(dir: string, base: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.git')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      await walk(abs, base, files);
    } else if (CODE_EXT.has(path.extname(e.name))) {
      files.push(abs);
    }
  }
}

export const analyzeCodeTool: Tool = {
  name: 'analyze_code',
  description:
    '在工作目录内检索某个关键字/符号，返回匹配的文件、行号与代码结构统计摘要（函数/类/导出数量）。',
  parameters: z.object({
    query: z.string().describe('要检索的关键字或符号名'),
    path: z.string().default('.').describe('检索的起始目录，默认整个工作目录'),
    regex: z.boolean().default(false).describe('是否将 query 作为正则表达式匹配'),
    ignoreCase: z.boolean().default(false).describe('是否忽略大小写'),
  }),
  async execute(args: { query: string; path: string; regex: boolean; ignoreCase: boolean }, ctx) {
    const root = resolveSafe(ctx.workdir, args.path || '.');
    const files: string[] = [];
    const stat = await fs.stat(root);
    if (stat.isDirectory()) await walk(root, root, files);
    else files.push(root);

    let matcher: (line: string) => boolean;
    if (args.regex) {
      let re: RegExp;
      try {
        re = new RegExp(args.query, args.ignoreCase ? 'i' : '');
      } catch (err) {
        return { ok: false, output: `正则表达式非法: ${err instanceof Error ? err.message : String(err)}` };
      }
      matcher = (line) => re.test(line);
    } else if (args.ignoreCase) {
      const queryLower = args.query.toLowerCase();
      matcher = (line) => line.toLowerCase().includes(queryLower);
    } else {
      matcher = (line) => line.includes(args.query);
    }

    const matches: Match[] = [];
    let fnCount = 0;
    let classCount = 0;
    let exportCount = 0;

    for (const f of files) {
      let content: string;
      try {
        content = await fs.readFile(f, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (matcher(line) && matches.length < 50) {
          matches.push({ file: path.relative(ctx.workdir, f), line: i + 1, text: line.trim().slice(0, 160), lines, index: i });
        }
        if (/\b(function|def |fn |=>)/.test(line)) fnCount++;
        if (/\bclass\s+\w/.test(line)) classCount++;
        if (/\bexport\b/.test(line)) exportCount++;
      });
    }

    const summary = [
      `检索 "${args.query}"（${args.regex ? '正则' : '子串'}${args.ignoreCase ? '，忽略大小写' : ''}）：扫描 ${files.length} 个文件，命中 ${matches.length} 处。`,
      `代码结构统计 → 函数/箭头函数: ${fnCount}，类: ${classCount}，导出: ${exportCount}。`,
    ];
    const matchBlocks = matches.slice(0, MAX_BLOCKS).map((m) => {
      const start = Math.max(0, m.index - CONTEXT_LINES);
      const end = Math.min(m.lines.length - 1, m.index + CONTEXT_LINES);
      const block = [`${m.file}:${m.line}`];
      for (let i = start; i <= end; i++) {
        const marker = i === m.index ? '  > ' : '    ';
        block.push(`${marker}${i + 1}| ${m.lines[i].slice(0, 160)}`);
      }
      return block.join('\n');
    });
    if (matchBlocks.length > 0) {
      summary.push('匹配片段:', matchBlocks.join('\n\n'));
      if (matches.length > MAX_BLOCKS) {
        summary.push(`...还有 ${matches.length - MAX_BLOCKS} 处命中未展示`);
      }
    }

    return {
      ok: true,
      output: summary.join('\n'),
      data: { files: files.length, matches: matches.length, fnCount, classCount, exportCount },
    };
  },
};
