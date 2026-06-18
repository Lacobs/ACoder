import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Tool } from './types.js';

async function runGit(args: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, timeout: timeoutMs });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      const out = (stdout + (stderr ? `\nstderr:\n${stderr}` : '')).trim();
      resolve({ ok: code === 0, output: out || `git ${args[0]} exit ${code}` });
    });

    child.on('error', (err) => {
      resolve({ ok: false, output: `git 命令执行失败: ${err.message}` });
    });
  });
}

const clipOutput = (s: string, maxLen: number = 6000) =>
  s.length > maxLen ? s.slice(0, maxLen) + '\n...[已截断]' : s;

export const gitDiffTool: Tool = {
  name: 'git_diff',
  description: '查看 Git 工作区/暂存区的改动（git diff）。查看未暂存或已暂存的代码变更。',
  parameters: z.object({
    staged: z.boolean().default(false).describe('true=查看已暂存的改动（git diff --staged），false=未暂存改动'),
    path: z.string().optional().describe('限定到某个文件/目录'),
  }),
  async execute(args, ctx) {
    const cmdArgs = ['diff', '--no-color'];
    if (args.staged) cmdArgs.push('--staged');
    if (args.path) cmdArgs.push('--', args.path);
    const r = await runGit(cmdArgs, ctx.workdir, ctx.commandTimeoutMs);
    return {
      ok: r.ok,
      output: r.output ? `git ${cmdArgs.join(' ')}\n\n${clipOutput(r.output)}` : r.output,
      data: { exitCode: r.ok ? 0 : 1 },
    };
  },
};

export const gitStatusTool: Tool = {
  name: 'git_status',
  description: '查看 Git 仓库状态（当前分支、工作区/暂存区文件状态）。等价于 git status --short -b。',
  parameters: z.object({}),
  async execute(_args, ctx) {
    const r = await runGit(['status', '--short', '-b'], ctx.workdir, ctx.commandTimeoutMs);
    return {
      ok: r.ok,
      output: r.output || '(工作区干净)',
      data: { exitCode: r.ok ? 0 : 1 },
    };
  },
};

export const gitLogTool: Tool = {
  name: 'git_log',
  description: '查看 Git 提交历史。返回最近的提交记录（hash、日期、作者、消息）。',
  parameters: z.object({
    maxCount: z.number().default(10).describe('返回的提交数量上限'),
    path: z.string().optional().describe('限定到某个文件/目录的提交历史'),
  }),
  async execute(args, ctx) {
    const cmdArgs = ['log', '--oneline', '--decorate', `-${Math.min(args.maxCount, 50)}`];
    if (args.path) cmdArgs.push('--', args.path);
    const r = await runGit(cmdArgs, ctx.workdir, ctx.commandTimeoutMs);
    return {
      ok: r.ok,
      output: r.output || '(无提交记录)',
      data: { exitCode: r.ok ? 0 : 1 },
    };
  },
};

export const gitShowTool: Tool = {
  name: 'git_show',
  description: '查看某个提交的详细信息（diff 内容），或某个文件在某个提交中的内容。',
  parameters: z.object({
    ref: z.string().describe('提交哈希、分支名或引用（如 HEAD、HEAD~1、abc1234）'),
    path: z.string().optional().describe('限定到某个文件'),
  }),
  async execute(args, ctx) {
    const cmdArgs = ['show', '--no-color', '--stat'];
    // 安全过滤 ref 参数，防止命令注入
    const safeRef = args.ref.replace(/[;&|`$(){}[\]<>!\\]/g, '');
    cmdArgs.push(safeRef);
    if (args.path) cmdArgs.push('--', args.path);
    const r = await runGit(cmdArgs, ctx.workdir, ctx.commandTimeoutMs);
    return {
      ok: r.ok,
      output: r.output ? `git show ${safeRef}\n\n${clipOutput(r.output)}` : r.output,
      data: { exitCode: r.ok ? 0 : 1 },
    };
  },
};
