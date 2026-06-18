import { z } from 'zod';
import type { Tool } from '../tools/types.js';

/**
 * 编排型工具的占位定义：它们的真实执行在推理循环中被特殊拦截
 * （spawn_subagent 由 orchestrator 委派，update_plan 由 Plan 执行器处理）。
 * 这里仅提供 schema，让模型知道可以调用它们。
 */

export const spawnSubAgentTool: Tool = {
  name: 'spawn_subagent',
  description:
    '将一个独立的子任务委派给隔离上下文的子代理执行，并返回其结论。适合可拆分、相对独立的子任务。',
  parameters: z.object({
    task: z.string().describe('子任务的清晰描述'),
    tools: z
      .array(z.string())
      .default([])
      .describe('允许子代理使用的工具名列表（留空表示使用全部基础工具）'),
  }),
  async execute() {
    // 实际逻辑在 loop.ts 中拦截处理，这里不会被调用。
    return { ok: true, output: '（spawn_subagent 由编排器处理）' };
  },
};

export const updatePlanTool: Tool = {
  name: 'update_plan',
  description:
    '在 Plan 模式执行过程中修正后续计划。action=add 追加步骤；action=replace 替换某个未完成步骤的标题。',
  parameters: z.object({
    action: z.enum(['add', 'replace']).describe('操作类型'),
    title: z.string().describe('新的步骤标题'),
    stepId: z.number().optional().describe('replace 时指定要修改的步骤 id'),
  }),
  async execute() {
    return { ok: true, output: '（update_plan 由计划执行器处理）' };
  },
};

export const useSkillTool: Tool = {
  name: 'use_skill',
  description:
    '当某个技能与当前任务相关时，调用本工具并传入技能名（name），以获取该技能的详细操作指令（渐进式披露），然后据此执行。可用技能见系统提示中的列表。',
  parameters: z.object({
    name: z.string().describe('要加载的技能名称，必须是系统提示中列出的可用技能之一'),
  }),
  async execute() {
    // 实际逻辑在 loop.ts 中拦截处理（按名加载技能指令）。
    return { ok: true, output: '（use_skill 由推理循环处理）' };
  },
};

