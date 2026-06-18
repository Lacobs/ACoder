import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Tool } from './types.js';

export const runCommandTool: Tool = {
  name: 'run_command',
  description: '在工作目录内执行一条 shell 命令，返回 stdout/stderr 与退出码（带超时保护）。修改代码后应使用本工具运行构建或测试命令（如 npm run build、npm test、tsc --noEmit）来验证改动是否正确。',
  parameters: z.object({
    command: z.string().describe('要执行的 shell 命令'),
  }),
  async execute(args: { command: string }, ctx) {
    return await new Promise((resolve) => {
      const child = spawn(args.command, {
        cwd: ctx.workdir,
        shell: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, ctx.commandTimeoutMs);

      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const clip = (s: string) => (s.length > 4000 ? s.slice(0, 4000) + '\n...[已截断]' : s);
        if (timedOut) {
          resolve({
            ok: false,
            output: `命令超时（>${ctx.commandTimeoutMs}ms）已被终止: ${args.command}`,
            data: { timedOut: true },
          });
          return;
        }
        const parts = [
          `$ ${args.command}`,
          `exitCode: ${code}`,
          stdout ? `stdout:\n${clip(stdout)}` : 'stdout: (空)',
          stderr ? `stderr:\n${clip(stderr)}` : '',
        ].filter(Boolean);
        resolve({
          ok: code === 0,
          output: parts.join('\n'),
          data: { exitCode: code, stdout, stderr },
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, output: `命令执行失败: ${err.message}` });
      });
    });
  },
};
