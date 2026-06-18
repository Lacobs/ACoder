import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Tool } from './types.js';
import { displayPath, resolveSafe } from './safe-path.js';

export const listDirTool: Tool = {
  name: 'list_dir',
  description: '列出工作目录内某个目录的文件与子目录。',
  parameters: z.object({
    path: z.string().default('.').describe('相对工作目录的目录路径，默认为根目录'),
  }),
  async execute(args: { path: string }, ctx) {
    const abs = resolveSafe(ctx.workdir, args.path || '.');
    const entries = await fs.readdir(abs, { withFileTypes: true });
    if (entries.length === 0) {
      return { ok: true, output: `目录 ${displayPath(ctx.workdir, abs)} 为空。`, data: { entries: [] } };
    }
    const lines: string[] = [];
    const names: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const isDir = e.isDirectory();
      let size = 0;
      if (!isDir) {
        try {
          const st = await fs.stat(path.join(abs, e.name));
          size = st.size;
        } catch {
          /* ignore */
        }
      }
      lines.push(isDir ? `[dir]  ${e.name}/` : `[file] ${e.name} (${size}B)`);
      names.push(e.name);
    }
    return {
      ok: true,
      output: `目录 ${displayPath(ctx.workdir, abs)} 包含 ${names.length} 项:\n${lines.join('\n')}`,
      data: { entries: names },
    };
  },
};
