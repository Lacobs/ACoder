import type { AgentMode } from '../config.js';

export interface PlanStep {
  id: number;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
}

export type AgentEvent =
  | { type: 'mode'; depth: number; mode: AgentMode; resolved: 'react' | 'plan'; reason: string }
  | { type: 'info'; depth: number; text: string }
  | { type: 'thinking_start'; depth: number }
  | { type: 'thinking_delta'; depth: number; delta: string }
  | { type: 'thinking_end'; depth: number }
  | { type: 'plan'; depth: number; steps: PlanStep[] }
  | { type: 'plan_update'; depth: number; steps: PlanStep[]; note?: string }
  | { type: 'tool_call'; depth: number; name: string; args: string }
  | { type: 'tool_result'; depth: number; name: string; ok: boolean; output: string }
  | { type: 'reflection'; depth: number; text: string }
  | { type: 'skill_loaded'; depth: number; name: string; description: string }
  | { type: 'compaction'; depth: number; beforeTokens: number; afterTokens: number; ratio: number; mode: string; droppedCount: number }
  | { type: 'subagent_start'; depth: number; task: string; tools: string[] }
  | { type: 'subagent_end'; depth: number; ok: boolean; summary: string }
  | { type: 'final'; depth: number; text: string }
  | { type: 'budget'; depth: number; steps: number; maxSteps: number; approxTokens: number }
  | { type: 'aborted'; depth: number };

export type EventEmitter = (event: AgentEvent) => void;

export interface SubAgentSpec {
  task: string;
  tools: string[];
}

export interface SubAgentResult {
  ok: boolean;
  summary: string;
}

/** 委派子代理执行子任务的函数签名（由 orchestrator 提供）。 */
export type Delegate = (spec: SubAgentSpec, parentDepth: number) => Promise<SubAgentResult>;

/** 中断信号：代理、子代理循环中定期检查，若已设置则尽快停止。 */
export interface AbortSignal {
  readonly aborted: boolean;
}

export function createAbortSignal(): { signal: AbortSignal; abort: () => void } {
  let aborted = false;
  return {
    signal: { get aborted() { return aborted; } },
    abort: () => { aborted = true; },
  };
}
