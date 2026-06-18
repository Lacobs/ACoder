import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Tool } from './types.js';
import { resolveSafe } from './safe-path.js';

/**
 * 简化 glob 匹配：仅支持 **、*、? 通配符。
 */
function globToRegex(pattern: string): RegExp {
  let p = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*(?=\/|$)/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/<<<GLOBSTAR>>>/g, '.*');
  return new RegExp(`^${p}$`);
}

async function walkGlob(
  dir: string,
  rootDir: string,
  includeRe: RegExp,
  excludeRe: RegExp | null,
  results: string[],
  maxResults: number,
): Promise<void> {
  if (results.length >= maxResults) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // 默认跳过常见无关目录
  const skipDirs = new Set(['node_modules', '.git', '.mca', '__pycache__', '.idea', '.vscode', 'dist', 'build', '.next', '.cache']);
  for (const e of entries) {
    if (results.length >= maxResults) return;
    const abs = path.join(dir, e.name);
    const rel = path.relative(rootDir, abs);
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || skipDirs.has(e.name)) continue;
      await walkGlob(abs, rootDir, includeRe, excludeRe, results, maxResults);
    } else if (e.isFile()) {
      if (excludeRe && excludeRe.test(rel)) continue;
      if (includeRe.test(rel)) {
        results.push(rel);
      }
    }
  }
}

export const globTool: Tool = {
  name: 'search_file',
  description:
    '按 glob 模式查找文件（如 "**/*.ts"、"src/**/*.test.ts"）。支持 ** 递归匹配、* 单层通配、? 单字符通配。自动跳过 node_modules/.git 等无关目录。',
  parameters: z.object({
    pattern: z.string().describe('glob 模式，如 "**/*.ts" 或 "src/**/*.spec.ts"（用 / 作为路径分隔符）'),
    path: z.string().default('.').describe('搜索起始目录，默认工作目录根'),
    exclude: z.string().optional().describe('排除匹配此模式的路径（如 "**/*.test.ts"、"**/node_modules/**"）'),
  }),
  async execute(args, ctx) {
    const root = resolveSafe(ctx.workdir, args.path || '.');
    const stat = fs.statSync(root, { throwIfNoEntry: false });
    if (!stat) return { ok: false, output: `路径不存在: ${args.path}` };

    const includeRe = globToRegex(args.pattern);
    const excludeRe = args.exclude ? globToRegex(args.exclude) : null;
    const maxResults = 200;
    const results: string[] = [];

    if (stat.isDirectory()) {
      await walkGlob(root, root, includeRe, excludeRe, results, maxResults);
    } else {
      const rel = path.relative(root, root);
      if (includeRe.test(rel)) results.push(rel);
    }

    if (results.length === 0) {
      return { ok: true, output: `未找到匹配 "${args.pattern}" 的文件。` };
    }

    const truncated = results.length >= maxResults;
    const display = results.slice(0, 100);
    const output = [
      `匹配 "${args.pattern}" 的文件（${results.length} 个${truncated ? '+' : ''}）：`,
      ...display.map((f) => `  ${f}`),
    ];
    if (results.length > 100) {
      output.push(`  ...还有 ${results.length - 100} 个文件未列出`);
    }

    return {
      ok: true,
      output: output.join('\n'),
      data: { files: results, total: results.length },
    };
  },
};
