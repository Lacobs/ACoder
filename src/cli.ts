#!/usr/bin/env node
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { loadConfig, type AgentMode } from './config.js';
import { createProvider } from './llm/index.js';
import { createBaseRegistry } from './tools/index.js';
import { createSkillRegistry } from './skills/registry.js';
import { createMemory } from './memory/index.js';
import { runAgent, createDelegate, spawnSubAgentTool, updatePlanTool, useSkillTool, type AgentDeps } from './agent/index.js';
import { buildSkillInstructions } from './agent/prompts.js';
import { createRenderer } from './ui/render.js';
import { createAbortSignal } from './agent/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(__dirname, '..', 'skills');

interface CliArgs {
  once?: string;
  mode?: AgentMode;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') args.once = argv[++i];
    else if (a === '--mode') {
      const m = argv[++i];
      if (m === 'react' || m === 'plan' || m === 'auto') args.mode = m;
    }
  }
  return args;
}

function banner(deps: AgentDeps, mode: AgentMode): void {
  const c = deps.config;
  console.log(chalk.bold.cyan('\n  ╔═══════════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('  ║   ACoder  ·  CLI Coding Agent                  ║'));
  console.log(chalk.bold.cyan('  ╚═══════════════════════════════════════════════╝'));
  console.log(
    `  ${chalk.dim('模型:')} ${c.useMock ? chalk.yellow('Mock(离线)') : chalk.green(c.model)}   ` +
    `${chalk.dim('模式:')} ${chalk.bold(mode)}   ${chalk.dim('工作目录:')} ${chalk.green(path.basename(c.workdir))}`,
  );
  console.log(
    `  ${chalk.dim('工具:')} ${deps.registry.list().length}   ${chalk.dim('技能:')} ${deps.skills.list().length}`,
  );
  console.log(chalk.dim('  输入开发任务，或 /help 查看命令。Ctrl+C 中断任务。\n'));
}

function printHelp(): void {
  console.log(chalk.bold('\n可用命令:'));
  console.log(`  ${chalk.cyan('/help')}              显示帮助`);
  console.log(`  ${chalk.cyan('/tools')}             列出可用工具`);
  console.log(`  ${chalk.cyan('/skills')}            列出可用技能`);
  console.log(`  ${chalk.cyan('/<技能名> <任务>')}   显式预加载指定技能并执行任务`);
  console.log(`  ${chalk.cyan('/mode [react|plan|auto]')}  查看或切换运行模式`);
  console.log(`  ${chalk.cyan('/exit')}              退出`);
  console.log(`  ${chalk.yellow('Ctrl+C')}              中断当前正在执行的任务\n`);
  console.log(chalk.dim('  直接输入自然语言即可让 Agent 执行任务。\n'));
}

function printTools(deps: AgentDeps): void {
  console.log(chalk.bold('\n可用工具:'));
  for (const t of deps.registry.list()) {
    console.log(`  ${chalk.yellow(t.name)} - ${t.description}`);
  }
  console.log('');
}

function printSkills(deps: AgentDeps): void {
  const skills = deps.skills.listUserInvocable();
  console.log(chalk.bold('\n可用技能:'));
  if (skills.length === 0) {
    console.log(chalk.dim('  (无)\n'));
    return;
  }
  for (const s of skills) {
    const when = s.whenToUse ? chalk.dim(`（适用：${s.whenToUse}）`) : '';
    console.log(`  ${chalk.magenta(s.name)} - ${s.description} ${when}`);
  }
  console.log(chalk.dim('  （Agent 会根据任务语义自动调用 use_skill；也可用 /<技能名> <任务> 显式预加载）\n'));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const provider = createProvider(config);
  const registry = createBaseRegistry();
  registry.register(spawnSubAgentTool);
  registry.register(updatePlanTool);
  registry.register(useSkillTool);
  const skills = createSkillRegistry(SKILLS_DIR);
  const memory = createMemory(provider, config.compression);

  const deps: AgentDeps = { config, provider, registry, skills, memory };
  const cliArgs = parseArgs(process.argv.slice(2));
  let mode: AgentMode = cliArgs.mode ?? config.defaultMode;

  const render = createRenderer();

  // 当前活跃的 abort controller（每次任务一个）
  let currentAbort: { abort: () => void } | null = null;

  // SIGINT 处理：中断当前任务但不退出进程
  let sigintCount = 0;
  process.on('SIGINT', () => {
    sigintCount++;
    if (currentAbort) {
      // 第一次 Ctrl+C：中断当前任务
      currentAbort.abort();
      currentAbort = null;
      console.log(chalk.yellow('\n⏸  任务已中断。输入新任务继续，或 /exit 退出。\n'));
      sigintCount = 0;
    } else if (sigintCount >= 2) {
      // 连续两次 Ctrl+C（无活跃任务）：退出
      console.log(chalk.dim('\n再见！\n'));
      process.exit(0);
    } else {
      console.log(chalk.dim('\n按 Ctrl+C 再次退出，或输入新任务继续。\n'));
    }
  });

  async function handleTask(task: string): Promise<void> {
    const emit = render;
    const delegate = createDelegate(deps, registry, emit);
    const { signal, abort } = createAbortSignal();
    currentAbort = { abort };

    try {
      await runAgent(deps, { task, mode, emit, delegate, depth: 0, abortSignal: signal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n执行出错: ${msg}\n`));
    } finally {
      currentAbort = null;
    }
  }

  // 单次模式
  if (cliArgs.once) {
    banner(deps, mode);
    console.log(chalk.bold(`\n> ${cliArgs.once}\n`));
    await handleTask(cliArgs.once);
    return;
  }

  banner(deps, mode);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.bold.green('› '),
  });
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input.startsWith('/')) {
      const [cmd, arg] = input.slice(1).split(/\s+/);
      switch (cmd) {
        case 'help':
          printHelp();
          break;
        case 'tools':
          printTools(deps);
          break;
        case 'skills':
          printSkills(deps);
          break;
        case 'mode':
          if (arg === 'react' || arg === 'plan' || arg === 'auto') {
            mode = arg;
            console.log(chalk.cyan(`已切换运行模式为: ${chalk.bold(mode)}\n`));
          } else {
            console.log(chalk.cyan(`当前模式: ${chalk.bold(mode)}（可用: react | plan | auto）\n`));
          }
          break;
        case 'exit':
        case 'quit':
          rl.close();
          return;
        default: {
          const skill = deps.skills.get(cmd);
          if (skill && skill.userInvocable !== false) {
            const task = input.slice(cmd.length + 1).trim();
            if (!task) {
              console.log(chalk.yellow(`用法: /${cmd} <任务描述>\n`));
              break;
            }
            const seeded = `${buildSkillInstructions(skill)}\n\n现在请基于上述技能指令完成任务：${task}`;
            console.log(chalk.magenta(`🎯 已预加载技能「${skill.name}」\n`));
            await handleTask(seeded);
            console.log('');
            break;
          }
          console.log(chalk.red(`未知命令: /${cmd}，输入 /help 查看帮助。\n`));
        }
      }
      rl.prompt();
      return;
    }

    await handleTask(input);
    console.log('');
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(chalk.dim('\n再见！\n'));
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(chalk.red('启动失败:'), err);
  process.exit(1);
});
