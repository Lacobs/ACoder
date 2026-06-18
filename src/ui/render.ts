import chalk from 'chalk';
import type { AgentEvent, PlanStep } from '../agent/types.js';

function indent(depth: number): string {
  return depth > 0 ? chalk.dim('│ '.repeat(depth)) : '';
}

function statusIcon(status: PlanStep['status']): string {
  switch (status) {
    case 'done':
      return chalk.green('✓');
    case 'running':
      return chalk.yellow('▸');
    case 'failed':
      return chalk.red('✗');
    default:
      return chalk.dim('○');
  }
}

/**
 * 创建一个有状态的渲染器，把 AgentEvent 流式渲染到终端。
 * 思考增量通过 thinking_delta 实时打印。
 */
export function createRenderer() {
  let thinkingActive = false;

  return function render(e: AgentEvent): void {
    const pad = indent(e.depth);

    switch (e.type) {
      case 'mode':
        process.stdout.write(
          `${pad}${chalk.magenta('◆ 模式')} ${chalk.bold(e.resolved.toUpperCase())} ${chalk.dim('(' + e.reason + ')')}\n`,
        );
        break;

      case 'info':
        process.stdout.write(`${pad}${chalk.cyan('ℹ')} ${e.text}\n`);
        break;

      case 'thinking_start':
        thinkingActive = false;
        process.stdout.write(`${pad}${chalk.blue('🧠 思考: ')}`);
        break;

      case 'thinking_delta':
        thinkingActive = true;
        process.stdout.write(chalk.gray(e.delta));
        break;

      case 'thinking_end':
        if (thinkingActive) process.stdout.write('\n');
        else process.stdout.write(chalk.dim('(无输出)\n'));
        thinkingActive = false;
        break;

      case 'plan':
        process.stdout.write(`${pad}${chalk.magenta('📋 计划:')}\n`);
        for (const s of e.steps) {
          process.stdout.write(`${pad}  ${statusIcon(s.status)} ${s.id}. ${s.title}\n`);
        }
        break;

      case 'plan_update':
        if (e.note) process.stdout.write(`${pad}${chalk.magenta('↻ 计划更新:')} ${chalk.dim(e.note)}\n`);
        for (const s of e.steps) {
          process.stdout.write(`${pad}  ${statusIcon(s.status)} ${s.id}. ${s.title}\n`);
        }
        break;

      case 'tool_call':
        process.stdout.write(`${pad}${chalk.yellow('🔧 调用工具')} ${chalk.bold(e.name)} ${chalk.dim(e.args)}\n`);
        break;

      case 'tool_result': {
        const tag = e.ok ? chalk.green('✓ 结果') : chalk.red('✗ 错误');
        const body = e.output
          .split('\n')
          .map((l) => `${pad}    ${chalk.dim(l)}`)
          .join('\n');
        process.stdout.write(`${pad}  ${tag} [${e.name}]\n${body}\n`);
        break;
      }

      case 'reflection':
        process.stdout.write(`${pad}${chalk.hex('#FFA500')('💭 反思:')} ${e.text}\n`);
        break;

      case 'skill_loaded':
        process.stdout.write(
          `${pad}${chalk.magenta('🎯 加载技能')} ${chalk.bold(e.name)} ${chalk.dim('—— ' + e.description)}\n`,
        );
        break;

      case 'compaction': {
        const pct = Math.round((1 - e.ratio) * 100);
        process.stdout.write(
          `${pad}${chalk.hex('#00CED1')('🗜  上下文压缩')} ${chalk.dim(
            `mode=${e.mode} ${e.beforeTokens}→${e.afterTokens} tokens (-${pct}%) 丢弃 ${e.droppedCount} 条`,
          )}\n`,
        );
        break;
      }

      case 'subagent_start':
        process.stdout.write(
          `${pad}${chalk.cyan('╭─ 🤖 子代理启动')} ${chalk.bold(e.task)} ${chalk.dim('[tools: ' + e.tools.join(', ') + ']')}\n`,
        );
        break;

      case 'subagent_end': {
        const tag = e.ok ? chalk.green('完成') : chalk.red('失败');
        process.stdout.write(`${pad}${chalk.cyan('╰─ 🤖 子代理' + tag + ':')} ${chalk.dim(clip(e.summary))}\n`);
        break;
      }

      case 'final':
        process.stdout.write(`\n${pad}${chalk.greenBright.bold('✅ 最终结果:')}\n`);
        process.stdout.write(
          e.text
            .split('\n')
            .map((l) => `${pad}  ${chalk.white(l)}`)
            .join('\n') + '\n',
        );
        break;

      case 'budget':
        process.stdout.write(
          `${pad}${chalk.dim(`⏱  预算: ${e.steps}/${e.maxSteps} 步, ~${e.approxTokens} tokens`)}\n`,
        );
        break;
    }
  };
}

function clip(s: string): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > 100 ? t.slice(0, 100) + '…' : t;
}
