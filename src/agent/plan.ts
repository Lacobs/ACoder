import { runReasoningLoop, seedTask, type LoopDeps, type LoopResult } from './loop.js';
import { buildSystemPrompt, buildPlanRequest } from './prompts.js';
import type { PlanStep, AbortSignal } from './types.js';
import type { EventEmitter } from './types.js';
import type { Skill } from '../skills/types.js';
import { Memory, createMemory } from '../memory/index.js';
import type { CompressionConfig } from '../memory/index.js';
import type { Message } from '../llm/index.js';

export interface PlanRunOptions extends Omit<LoopDeps, 'emit' | 'depth' | 'maxReflectRetries' | 'resolveSkill' | 'abortSignal'> {
  task: string;
  skills: Skill[];
  resolveSkill?: (name: string) => Skill | undefined;
  isSubAgent: boolean;
  contextLimit: number;
  compression: CompressionConfig;
  memoryPrompt?: string;
  abortSignal?: AbortSignal;
}

interface PlanShape {
  steps: { title: string }[];
}

async function generatePlan(opts: PlanRunOptions): Promise<PlanStep[]> {
  const planMemory = new Memory({ contextLimit: opts.contextLimit });
  planMemory.add({
    role: 'system',
    content: '你是一个任务规划助手，把用户任务拆解为有序、可执行的步骤。',
  });
  planMemory.add({ role: 'user', content: buildPlanRequest(opts.task) });

  const res = await opts.provider.chat({ messages: planMemory.getMessages() });
  const steps = parsePlan(res.content);
  return steps.map((title, i) => ({ id: i + 1, title, status: 'pending' as const }));
}

function parsePlan(content: string): string[] {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as PlanShape;
      if (Array.isArray(parsed.steps)) {
        return parsed.steps.map((s) => s.title).filter(Boolean);
      }
    }
  } catch {
    /* fall through */
  }
  return content
    .split('\n')
    .map((l) => l.replace(/^[\s\-*\d.)]+/, '').trim())
    .filter((l) => l.length > 0)
    .slice(0, 8);
}

/**
 * Plan 模式：先生成计划，再逐步执行。
 * 每个步骤都会复用核心推理循环；执行中可通过观察结果对剩余步骤进行简单修正。
 */
export async function runPlan(
  opts: PlanRunOptions,
  deps: Pick<LoopDeps, 'emit' | 'depth' | 'maxReflectRetries'>,
): Promise<LoopResult> {
  const { emit, depth } = deps;

  let steps = await generatePlan(opts);
  if (steps.length === 0) {
    steps = [{ id: 1, title: opts.task, status: 'pending' }];
  }
  emit({ type: 'plan', depth, steps: clone(steps) });

  const stepSummaries: string[] = [];

  for (let i = 0; i < steps.length; i++) {
    // 中断检查
    if (opts.abortSignal?.aborted) {
      emit({ type: 'plan_update', depth, steps: clone(steps), note: '任务已被用户中断。' });
      emit({ type: 'aborted', depth });
      return { finalText: stepSummaries.join('\n') || '（任务已被用户中断）', stoppedReason: 'aborted' };
    }

    if (opts.budget.exhausted()) {
      emit({ type: 'plan_update', depth, steps: clone(steps), note: '预算耗尽，提前结束计划执行。' });
      break;
    }
    const step = steps[i];
    step.status = 'running';
    emit({ type: 'plan_update', depth, steps: clone(steps), note: `开始执行步骤 ${step.id}` });

    const stepMemory = createMemory(opts.provider, opts.compression);
    for (const f of opts.memory.getFacts()) stepMemory.remember(f);

    const systemPrompt = buildSystemPrompt({
      workdir: opts.toolCtx.workdir,
      toolSchemas: opts.registry.schemas(),
      skills: opts.skills,
      isSubAgent: opts.isSubAgent,
      facts: stepMemory.getFacts(),
      memoryPrompt: opts.memoryPrompt,
    });
    const stepTask = buildStepTask(opts.task, steps, i, stepSummaries);
    seedTask(stepMemory, systemPrompt, stepTask);

    const result = await runReasoningLoop({
      provider: opts.provider,
      registry: opts.registry,
      memory: stepMemory,
      budget: opts.budget,
      toolCtx: opts.toolCtx,
      delegate: opts.delegate,
      resolveSkill: opts.resolveSkill,
      emit,
      depth,
      maxReflectRetries: deps.maxReflectRetries,
      onUpdatePlan: (rawArgs) => applyPlanUpdate(steps, i, rawArgs, emit, depth),
      abortSignal: opts.abortSignal,
    });

    if (result.stoppedReason === 'aborted') {
      step.status = 'failed';
      emit({ type: 'plan_update', depth, steps: clone(steps), note: '步骤因中断而停止。' });
      return { finalText: stepSummaries.join('\n') || '（任务已被用户中断）', stoppedReason: 'aborted' };
    }

    step.status = result.stoppedReason === 'budget' ? 'failed' : 'done';
    stepSummaries.push(`步骤${step.id}「${step.title}」结果：${clip(result.finalText)}`);
    opts.memory.remember(stepSummaries[stepSummaries.length - 1]);
    emit({ type: 'plan_update', depth, steps: clone(steps) });
  }

  const summaryMemory = new Memory({ contextLimit: opts.contextLimit });
  summaryMemory.add({ role: 'system', content: '请把多步执行的结果汇总为简洁的最终答复。' });
  summaryMemory.add({
    role: 'user',
    content: `原始任务：${opts.task}\n\n各步骤结果：\n${stepSummaries.join('\n')}\n\n请给出最终结论。`,
  });
  const finalRes = await opts.provider.chat({ messages: summaryMemory.getMessages() }, (delta) =>
    emitFinalDelta(deps, delta),
  );
  const finalText = finalRes.content || stepSummaries.join('\n');
  return { finalText, stoppedReason: 'final' };
}

function buildStepTask(
  task: string,
  steps: PlanStep[],
  index: number,
  prevSummaries: string[],
): string {
  const lines = [
    `总体任务：${task}`,
    '',
    '完整计划：',
    ...steps.map((s) => `  ${s.id}.[${s.status}] ${s.title}`),
    '',
    `请只专注完成当前步骤 ${steps[index].id}：${steps[index].title}`,
  ];
  if (prevSummaries.length > 0) {
    lines.push('', '此前步骤的结果：', ...prevSummaries);
  }
  lines.push('', '完成该步骤后给出该步骤的简短结论即可。');
  return lines.join('\n');
}

function emitFinalDelta(
  deps: Pick<LoopDeps, 'emit' | 'depth'>,
  delta: string,
): void {
  deps.emit({ type: 'thinking_delta', depth: deps.depth, delta });
}

function clone(steps: PlanStep[]): PlanStep[] {
  return steps.map((s) => ({ ...s }));
}

function clip(s: string): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > 160 ? t.slice(0, 160) + '…' : t;
}

function applyPlanUpdate(
  steps: PlanStep[],
  currentIndex: number,
  rawArgs: string,
  emit: EventEmitter,
  depth: number,
): string {
  let payload: { action?: string; title?: string; stepId?: number };
  try {
    payload = JSON.parse(rawArgs || '{}');
  } catch {
    return 'update_plan 参数不是合法 JSON，未修改计划。';
  }

  if (payload.action === 'add' && payload.title) {
    const newStep: PlanStep = {
      id: steps.length + 1,
      title: payload.title,
      status: 'pending',
    };
    steps.push(newStep);
    emit({ type: 'plan_update', depth, steps: steps.map((s) => ({ ...s })), note: `新增步骤：${payload.title}` });
    return `已新增步骤 ${newStep.id}：${payload.title}`;
  }

  if (payload.action === 'replace' && payload.title && payload.stepId) {
    const target = steps.find((s) => s.id === payload.stepId && s.id > steps[currentIndex].id - 1);
    if (target && target.status === 'pending') {
      const old = target.title;
      target.title = payload.title;
      emit({ type: 'plan_update', depth, steps: steps.map((s) => ({ ...s })), note: `修改步骤 ${target.id}` });
      return `已将步骤 ${target.id} 从「${old}」修改为「${payload.title}」`;
    }
    return '未找到可修改的待执行步骤（不能修改已完成步骤）。';
  }

  return '未识别的 update_plan 操作（支持 action=add|replace）。';
}

export type { Message };
