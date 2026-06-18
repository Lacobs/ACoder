import type { LLMProvider, Message } from '../llm/index.js';
import type { ToolRegistry, ToolContext } from '../tools/index.js';
import { Memory, Budget } from '../memory/index.js';
import type { AgentEvent, EventEmitter, Delegate } from './types.js';
import type { Skill } from '../skills/types.js';
import { buildSkillInstructions } from './prompts.js';

export interface LoopDeps {
  provider: LLMProvider;
  registry: ToolRegistry;
  memory: Memory;
  budget: Budget;
  toolCtx: ToolContext;
  emit: EventEmitter;
  depth: number;
  maxReflectRetries: number;
  /** Provided when spawn_subagent is available. */
  delegate?: Delegate;
  /** Provided when running inside Plan mode; lets the model revise remaining steps. */
  onUpdatePlan?: (rawArgs: string) => string;
  /** Resolve a skill by name for use_skill (progressive disclosure). */
  resolveSkill?: (name: string) => Skill | undefined;
}

export interface LoopResult {
  finalText: string;
  stoppedReason: 'final' | 'budget';
}

/**
 * 核心 think→tool→observe 循环：
 * 反复调用 LLM，执行其请求的工具，回填观察，直到模型不再调用工具或预算耗尽。
 * 内置反思自纠：工具失败时注入反思提示并允许有限次重试。
 */
export async function runReasoningLoop(deps: LoopDeps): Promise<LoopResult> {
  const { provider, registry, memory, budget, toolCtx, emit, depth } = deps;
  let lastAssistant = '';
  let reflectUsed = 0;
  // 「改动后强制验证」闭环状态：
  // pendingVerification 表示存在尚未验证的代码改动；verifyPrompted 记录已注入的验证提示次数。
  let pendingVerification = false;
  let verifyPrompted = 0;
  const maxVerifyPrompts = deps.maxReflectRetries;

  while (true) {
    if (!budget.consumeStep()) {
      emitBudget(deps);
      const reason = budget.tokensExhausted() ? 'token 预算' : '步数预算';
      return { finalText: lastAssistant || `（达到${reason}，返回当前进展）`, stoppedReason: 'budget' };
    }

    // 调用模型前触发上下文压缩（可能是 LLM 摘要），最大化节省 token。
    const compaction = await memory.maybeCompact();
    if (compaction) {
      emit({
        type: 'compaction',
        depth,
        beforeTokens: compaction.beforeTokens,
        afterTokens: compaction.afterTokens,
        ratio: compaction.ratio,
        mode: compaction.mode,
        droppedCount: compaction.droppedCount,
      });
    }

    emit({ type: 'thinking_start', depth });
    const response = await provider.chat(
      { messages: memory.getMessages(), tools: registry.schemas() },
      (delta) => emit({ type: 'thinking_delta', depth, delta }),
    );
    emit({ type: 'thinking_end', depth });
    budget.addTokens(memory.approxTokens());

    if (response.content) lastAssistant = response.content;

    // 无工具调用 => 最终答复
    if (response.toolCalls.length === 0) {
      // 输出因长度被截断：记录已生成内容并提示续写，而非当作完成
      if (response.finishReason === 'length') {
        memory.add({ role: 'assistant', content: response.content });
        memory.add({
          role: 'user',
          content: '[系统提示] 你的上一条输出因长度限制被截断。请基于已生成的内容继续完成剩余部分；若是在生成代码，请确保最终文件完整。',
        });
        emit({ type: 'reflection', depth, text: '检测到输出被截断，已请求模型续写。' });
        continue;
      }
      // 改动后强制验证：若存在尚未验证的代码改动且仍有验证额度，则不立即返回，
      // 而是要求模型运行构建/测试命令确认改动正确，形成验证闭环（避免死循环：受 maxVerifyPrompts 上限约束）。
      if (pendingVerification && verifyPrompted < maxVerifyPrompts) {
        memory.add({ role: 'assistant', content: response.content });
        memory.add({
          role: 'user',
          content: '[系统提示] 你已修改了代码文件但尚未验证。请运行构建或测试命令（如 npm run build、npm test 或 tsc --noEmit）确认改动正确；若验证通过再结束，若失败请修复后重试。',
        });
        emit({ type: 'reflection', depth, text: '检测到未验证的代码改动，已要求模型运行验证。' });
        verifyPrompted += 1;
        continue;
      }
      memory.add({ role: 'assistant', content: response.content });
      emitBudget(deps);
      return { finalText: response.content || lastAssistant, stoppedReason: 'final' };
    }

    // 记录助手的工具调用消息
    memory.add({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

    // 本轮所有 tool_calls 必须每个都补上对应的 tool 消息（协议要求），
    // 否则下一轮发送时会因「tool_calls 未被完整响应」而报 400。
    const failures: string[] = [];
    for (const call of response.toolCalls) {
      // 子代理委派工具单独处理
      if (call.name === 'spawn_subagent' && deps.delegate) {
        const result = await handleSpawn(deps, call.id, call.arguments);
        memory.add({ role: 'tool', name: call.name, toolCallId: call.id, content: result });
        continue;
      }

      // 计划更新工具（仅 Plan 模式提供）
      if (call.name === 'update_plan' && deps.onUpdatePlan) {
        const note = deps.onUpdatePlan(call.arguments);
        memory.add({ role: 'tool', name: call.name, toolCallId: call.id, content: note });
        continue;
      }

      // 技能渐进式披露：use_skill 按名加载技能完整指令并注入对话
      if (call.name === 'use_skill' && deps.resolveSkill) {
        const content = handleUseSkill(deps, call.arguments);
        memory.add({ role: 'tool', name: call.name, toolCallId: call.id, content });
        continue;
      }

      emit({ type: 'tool_call', depth, name: call.name, args: call.arguments });
      const toolResult = await registry.execute(call.name, call.arguments, toolCtx);
      emit({ type: 'tool_result', depth, name: call.name, ok: toolResult.ok, output: toolResult.output });

      // 始终为该 tool_call 补上 tool 消息，保证与 tool_calls 一一配对
      memory.add({ role: 'tool', name: call.name, toolCallId: call.id, content: toolResult.output });

      // 「改动后强制验证」状态维护：
      // - 成功写/改文件 => 存在尚未验证的代码改动
      // - 成功执行命令（退出码 0）=> 视为验证通过，清除待验证标记
      // - 命令执行失败时保持 pendingVerification 为 true，并经由下方 failures 触发反思修复
      if ((call.name === 'write_file' || call.name === 'edit_file') && toolResult.ok) {
        pendingVerification = true;
      } else if (call.name === 'run_command' && toolResult.ok) {
        pendingVerification = false;
      }

      if (!toolResult.ok) failures.push(`${call.name}: ${toolResult.output}`);
    }

    // 反思自纠：本轮全部 tool 响应补齐后，若有失败且仍有反思额度，追加一条反思提示让模型重试。
    if (failures.length > 0 && reflectUsed < deps.maxReflectRetries) {
      reflectUsed += 1;
      const reflection = `以下工具调用失败：\n${failures.join('\n')}\n请分析原因并改用更合适的参数或工具重试。`;
      emit({ type: 'reflection', depth, text: reflection });
      memory.add({ role: 'user', content: `[反思] ${reflection}` });
    }
  }
}

async function handleSpawn(deps: LoopDeps, _callId: string, rawArgs: string): Promise<string> {
  let spec: { task?: string; tools?: string[] };
  try {
    spec = JSON.parse(rawArgs || '{}');
  } catch {
    return '子代理参数不是合法 JSON，委派失败。';
  }
  if (!spec.task) return '子代理缺少 task 描述，委派失败。';
  const result = await deps.delegate!(
    { task: spec.task, tools: Array.isArray(spec.tools) ? spec.tools : [] },
    deps.depth,
  );
  return `子代理执行${result.ok ? '成功' : '失败'}。结论摘要：\n${result.summary}`;
}

function handleUseSkill(deps: LoopDeps, rawArgs: string): string {
  let spec: { name?: string };
  try {
    spec = JSON.parse(rawArgs || '{}');
  } catch {
    return 'use_skill 参数不是合法 JSON，加载失败。';
  }
  if (!spec.name) return 'use_skill 缺少 name 参数，加载失败。';
  const skill = deps.resolveSkill!(spec.name);
  if (!skill) {
    return `未找到名为「${spec.name}」的技能。请从系统提示列出的可用技能中选择。`;
  }
  deps.emit({ type: 'skill_loaded', depth: deps.depth, name: skill.name, description: skill.description });
  return buildSkillInstructions(skill);
}

function emitBudget(deps: LoopDeps): void {
  const s = deps.budget.snapshot();
  deps.emit({ type: 'budget', depth: deps.depth, steps: s.steps, maxSteps: s.maxSteps, approxTokens: s.approxTokens });
}

export function seedTask(memory: Memory, systemPrompt: string, task: string): void {
  memory.add({ role: 'system', content: systemPrompt });
  memory.add({ role: 'user', content: task });
}

export type { Message };
