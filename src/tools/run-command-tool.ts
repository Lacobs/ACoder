import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Tool } from './types.js';

/**
 * 危险命令模式列表：匹配时拒绝执行并返回明确的安全提示。
 * 设计原则：宁可误拦也要安全，模型提示中说明可换安全等效写法。
 */
const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[^-\s]*r[^-\s]*f|-[^-\s]*f[^-\s]*r)\s+\//, reason: '递归强制删除根目录或绝对路径（rm -rf /）' },
  { pattern: /\brm\s+(-[^-\s]*r[^-\s]*f|-[^-\s]*f[^-\s]*r)\s+~/, reason: '递归强制删除用户家目录（rm -rf ~）' },
  { pattern: /\bsudo\b/, reason: 'sudo 提权操作，请改用非特权方式或手动执行' },
  { pattern: /\bchmod\s+(-R\s+)?777\b/, reason: 'chmod 777 开放所有权限存在安全风险' },
  { pattern: /\bchown\s+(-R\s+)?[^ ]+:[^ ]+\s+\//, reason: '递归修改根目录所有者' },
  { pattern: />\s*\/dev\/[a-z]+d[a-z]/, reason: '直接写入磁盘设备（如 /dev/sda），可损坏系统' },
  { pattern: /\bmkfs\./, reason: '格式化文件系统命令' },
  { pattern: /\bdd\s+if=/, reason: 'dd 磁盘操作可能破坏数据' },
  { pattern: /\b:\(\)\s*\{\s*:\|:&\s*\}\s*;/, reason: 'fork bomb' },
  { pattern: /\bcurl\s+.*\|\s*(ba)?sh\b/, reason: 'curl 管道传递给 shell（curl | sh）不安全' },
  { pattern: /\bwget\s+.*\|\s*(ba)?sh\b/, reason: 'wget 管道传递给 shell（wget | sh）不安全' },
  { pattern: /\bgit\s+push\s+--force\b/, reason: 'git push --force 可能覆盖远程历史，请确认后再手动操作' },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'git reset --hard 会丢弃所有本地改动' },
  { pattern: /\bshutdown\b/, reason: '关机/重启命令' },
  { pattern: /\breboot\b/, reason: '重启命令' },
  { pattern: /\bkill\s+-9\s+-1\b/, reason: 'kill -9 -1 会终止所有进程' },
];

function checkDangerous(command: string): string | null {
  const trimmed = command.trim();
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return `拒绝执行危险命令：${reason}\n命令：${trimmed}\n请使用安全等效操作或手动确认后执行。`;
    }
  }
  return null;
}

export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    '在工作目录内执行一条 shell 命令，返回 stdout/stderr 与退出码（带超时保护）。修改代码后应使用本工具运行构建或测试命令来验证改动。注意：破坏性命令（rm -rf /、sudo、curl|sh 等）会被自动拒绝。',
  parameters: z.object({
    command: z.string().describe('要执行的 shell 命令'),
  }),
  async execute(args: { command: string }, ctx) {
    // 安全检查
    const danger = checkDangerous(args.command);
    if (danger) {
      return { ok: false, output: danger };
    }

    return await new Promise((resolve) => {
      const child = spawn(args.command, {
        cwd: ctx.workdir,
        shell: true,
        env: {
          ...process.env,
          // 注入环境变量禁止交互式提示
          CI: 'true',
          DEBIAN_FRONTEND: 'noninteractive',
        },
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
