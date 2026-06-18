import type { AppConfig, AgentMode } from '../config.js';
import type { LLMProvider } from '../llm/index.js';
import type { ToolRegistry, ToolContext } from '../tools/index.js';
import type { SkillRegistry } from '../skills/index.js';
import { Memory, Budget, getMemoryDir, buildMemoryPrompt } from '../memory/index.js';
import type { AgentEvent, EventEmitter, Delegate, AbortSignal } from './types.js';
import { runReact } from './react.js';
import { runPlan } from './plan.js';

export interface AgentDeps {
  config: AppConfig;
  provider: LLMProvider;
  registry: ToolRegistry;
  skills: SkillRegistry;
  memory: Memory;
}

export interface RunOptions {
  task: string;
  mode: AgentMode;
  emit: EventEmitter;
  delegate?: Delegate;
  depth?: number;
  isSubAgent?: boolean;
  budget?: Budget;
  /** Override tool registry (e.g. sub-agent restricted set). */
  registry?: ToolRegistry;
  /** Use a fresh memory rather than the shared session memory. */
  memory?: Memory;
  /** Abort signal for graceful interruption. */
  abortSignal?: AbortSignal;
}

/**
 * auto 模式下判定使用 plan 还是 react。
 * 基于可解释的多信号加权评分，达到阈值才进入 Plan 模式。
 */
const PLAN_SCORE_THRESHOLD = 2;

function resolveMode(task: string, mode: AgentMode): { resolved: 'react' | 'plan'; reason: string } {
  if (mode === 'react') return { resolved: 'react', reason: '用户指定 ReAct 模式' };
  if (mode === 'plan') return { resolved: 'plan', reason: '用户指定 Plan 模式' };

  const text = task.trim();
  const signals: string[] = [];
  let score = 0;

  const sequenceWords = ['然后', '接着', '之后', '再', '依次', '并且', '同时', '分别', '最后'];
  const seqHits = sequenceWords.filter((w) => text.includes(w)).length;
  if (seqHits > 0) {
    const s = Math.min(seqHits, 2);
    score += s;
    signals.push(`顺序连接词×${seqHits}`);
  }

  if (/(^|\s)\d+[.)、]|步骤|第[一二三四五六七八九十]步|拆分|分解/.test(text)) {
    score += 1;
    signals.push('显式分步');
  }

  const actionVerbs = ['创建', '新增', '修改', '删除', '重构', '实现', '修复', '添加', '删掉', '更新', '编写', '测试', '运行', '分析', '审查', '读取', '写入', '生成', '配置', '部署'];
  const verbHits = actionVerbs.filter((w) => text.includes(w)).length;
  if (verbHits >= 2) {
    score += 1;
    signals.push(`多动作动词×${verbHits}`);
  }

  if (text.length > 80) {
    score += 1;
    signals.push(`长任务(${text.length}字)`);
  }

  if (score >= PLAN_SCORE_THRESHOLD) {
    return { resolved: 'plan', reason: `复杂度评分 ${score}≥${PLAN_SCORE_THRESHOLD}（${signals.join('、')}）` };
  }
  return { resolved: 'react', reason: `复杂度评分 ${score}<${PLAN_SCORE_THRESHOLD}，判定为简单任务` };
}

export async function runAgent(deps: AgentDeps, opts: RunOptions): Promise<string> {
  const { config, provider, skills } = deps;
  const registry = opts.registry ?? deps.registry;
  const memory = opts.memory ?? deps.memory;
  const depth = opts.depth ?? 0;
  const isSubAgent = opts.isSubAgent ?? false;
  const budget = opts.budget ?? new Budget(config.maxSteps, config.maxTokens);

  const { resolved, reason } = resolveMode(opts.task, opts.mode);
  opts.emit({ type: 'mode', depth, mode: opts.mode, resolved, reason });

  const skillCatalog = skills.list();
  const resolveSkill = (name: string) => skills.get(name);

  const memoryPrompt = isSubAgent ? undefined : buildMemoryPrompt(getMemoryDir(config.workdir));

  const toolCtx: ToolContext = {
    workdir: config.workdir,
    commandTimeoutMs: config.commandTimeoutMs,
  };

  const common = {
    provider,
    registry,
    memory,
    budget,
    toolCtx,
    delegate: opts.delegate,
    skills: skillCatalog,
    resolveSkill,
    isSubAgent,
    task: opts.task,
    memoryPrompt,
    abortSignal: opts.abortSignal,
  };

  const loopDeps = {
    emit: opts.emit,
    depth,
    maxReflectRetries: config.maxReflectRetries,
  };

  let result;
  if (resolved === 'plan') {
    result = await runPlan(
      { ...common, contextLimit: config.contextLimit, compression: config.compression },
      loopDeps,
    );
  } else {
    result = await runReact(common, loopDeps);
  }

  opts.emit({ type: 'final', depth, text: result.finalText });
  memory.remember(`任务「${opts.task.slice(0, 40)}」的结论：${result.finalText.slice(0, 200)}`);
  return result.finalText;
}

export type { AgentEvent };
