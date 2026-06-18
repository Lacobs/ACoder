import type { AppConfig } from '../config.js';
import { createMemory, Budget } from '../memory/index.js';
import type { ToolRegistry } from '../tools/index.js';
import { runAgent, type AgentDeps } from './agent.js';
import type { Delegate, EventEmitter, SubAgentResult, SubAgentSpec } from './types.js';

/**
 * 创建一个 Delegate 函数：被主代理通过 spawn_subagent 调用时，
 * 生成一个拥有「独立记忆 + 受限工具集 + 独立步数预算」的子代理执行子任务。
 * 子代理事件以 depth+1 冒泡到同一事件流；失败与预算耗尽被隔离处理。
 */
export function createDelegate(deps: AgentDeps, baseRegistry: ToolRegistry, emit: EventEmitter): Delegate {
  const config: AppConfig = deps.config;

  const delegate: Delegate = async (spec: SubAgentSpec, parentDepth: number): Promise<SubAgentResult> => {
    const childDepth = parentDepth + 1;
    const toolNames =
      spec.tools.length > 0
        ? spec.tools.filter((n) => baseRegistry.has(n))
        : baseRegistry.list().map((t) => t.name).filter((n) => n !== 'spawn_subagent');

    emit({ type: 'subagent_start', depth: childDepth, task: spec.task, tools: toolNames });

    // 子代理工具集（默认不允许再次派生子代理，避免无限递归）
    const childRegistry = baseRegistry.subset(toolNames);
    const childMemory = createMemory(deps.provider, config.compression);
    const childBudget = new Budget(config.subagentMaxSteps, config.maxTokens);

    try {
      const text = await runAgent(deps, {
        task: spec.task,
        mode: 'react',
        emit,
        depth: childDepth,
        isSubAgent: true,
        budget: childBudget,
        registry: childRegistry,
        memory: childMemory,
        // 不传 delegate => 子代理无法再派生子代理
      });
      emit({ type: 'subagent_end', depth: childDepth, ok: true, summary: text });
      return { ok: true, summary: text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ type: 'subagent_end', depth: childDepth, ok: false, summary: msg });
      return { ok: false, summary: `子代理执行失败：${msg}` };
    }
  };

  return delegate;
}
