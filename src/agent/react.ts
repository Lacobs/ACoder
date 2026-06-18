import { runReasoningLoop, seedTask, type LoopDeps, type LoopResult } from './loop.js';
import { buildSystemPrompt } from './prompts.js';
import type { Skill } from '../skills/types.js';
import type { AbortSignal } from './types.js';

export interface ReactRunOptions extends Omit<LoopDeps, 'emit' | 'depth' | 'maxReflectRetries' | 'resolveSkill' | 'abortSignal'> {
  task: string;
  skills: Skill[];
  resolveSkill?: (name: string) => Skill | undefined;
  isSubAgent: boolean;
  memoryPrompt?: string;
  abortSignal?: AbortSignal;
}

/** ReAct 模式：直接进入「思考→工具→观察」反应式循环。 */
export async function runReact(
  opts: ReactRunOptions,
  deps: Pick<LoopDeps, 'emit' | 'depth' | 'maxReflectRetries'>,
): Promise<LoopResult> {
  const systemPrompt = buildSystemPrompt({
    workdir: opts.toolCtx.workdir,
    toolSchemas: opts.registry.schemas(),
    skills: opts.skills,
    isSubAgent: opts.isSubAgent,
    facts: opts.memory.getFacts(),
    memoryPrompt: opts.memoryPrompt,
  });
  seedTask(opts.memory, systemPrompt, opts.task);

  return runReasoningLoop({
    provider: opts.provider,
    registry: opts.registry,
    memory: opts.memory,
    budget: opts.budget,
    toolCtx: opts.toolCtx,
    delegate: opts.delegate,
    resolveSkill: opts.resolveSkill,
    emit: deps.emit,
    depth: deps.depth,
    maxReflectRetries: deps.maxReflectRetries,
    abortSignal: opts.abortSignal,
  });
}
