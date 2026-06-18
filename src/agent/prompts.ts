import type { Skill } from '../skills/types.js';
import type { ToolSchema } from '../llm/types.js';
import { substituteSkillVars } from '../skills/loader.js';

export function buildSystemPrompt(opts: {
  workdir: string;
  toolSchemas: ToolSchema[];
  skills: Skill[];
  isSubAgent: boolean;
  facts: string[];
  /** 项目级长期记忆段（仅主代理注入）。 */
  memoryPrompt?: string;
}): string {
  const lines: string[] = [];
  lines.push(
    opts.isSubAgent
      ? '你是一个专注的子代理（Sub-Agent），负责独立完成被委派的子任务，并返回简洁的结论。'
      : '你是一个类似 Claude Code 的命令行 Coding Agent，能够通过调用工具来完成开发任务。',
  );
  lines.push(`当前工作目录（所有文件/命令均限制在此目录内）：${opts.workdir}`);
  lines.push('');
  lines.push('行为准则：');
  lines.push('- 通过调用工具来获取信息或执行操作，不要编造文件内容或命令输出。');
  lines.push('- 每一步先简要说明你的思考，再决定是否调用工具。');
  lines.push('- 当信息足够时，停止调用工具并直接给出最终答复。');
  lines.push('- 最终答复要简洁、结构化、可执行。');

  lines.push('');
  lines.push('代码编辑规范：');
  lines.push('- 修改已有文件前，必须先用 read_file 读取并确认其完整内容，禁止在未读全的情况下覆盖。');
  lines.push('- 优先使用 edit_file 做精确局部修改；仅在创建新文件或整体重写时才用 write_file（它会覆盖整个文件）。');
  lines.push('- 坚持最小改动原则：只修改与任务直接相关的代码，不要顺手重排、重命名或重写无关内容，也不要为假想的未来需求增加额外抽象。');
  lines.push('- 保持与既有代码风格一致：命名、缩进、引号、导入顺序与错误处理风格都要与周围代码统一。');
  lines.push('- 禁止臆造不存在的 API、函数、配置项或依赖；不确定时必须先用 read_file / analyze_code 查证真实签名与用法（引入第三方库前先用 read_file 查看 package.json 确认其可用），宁可查证也不要猜测。');
  lines.push('- 开始编码前，先用 list_dir / analyze_code / read_file 了解项目结构与相关实现。');
  lines.push('- 完成代码改动后必须自检并用 run_command 运行验证（构建或测试，如 npm run build、npm test、tsc --noEmit）；验证未通过不得当作任务完成，需修复后重试。');

  if (opts.facts.length > 0) {
    lines.push('');
    lines.push('已知会话事实（可复用，无需重新获取）：');
    for (const f of opts.facts.slice(-8)) lines.push(`- ${f}`);
  }

  if (opts.memoryPrompt) {
    lines.push('');
    lines.push(opts.memoryPrompt);
  }

  if (opts.skills.length > 0) {
    lines.push('');
    lines.push('可用技能（渐进式披露）：以下技能封装了处理特定任务的专家流程。');
    lines.push('请根据任务语义判断哪个技能相关；如相关，先调用 `use_skill` 工具并传入其 name 获取完整操作指令，再据此执行。');
    for (const s of opts.skills) {
      const when = s.whenToUse ? `（适用：${s.whenToUse}）` : '';
      lines.push(`- ${s.name}: ${s.description}${when}`);
    }
  }

  lines.push('');
  lines.push('可用工具：');
  for (const t of opts.toolSchemas) {
    lines.push(`- ${t.name}: ${t.description}`);
  }

  return lines.join('\n');
}

/** 当模型通过 use_skill 加载某技能后，返回注入到对话中的技能指令文本。 */
export function buildSkillInstructions(skill: Skill): string {
  const instructions = substituteSkillVars(skill.instructions, skill.baseDir);
  const lines = [
    `【已加载技能：${skill.name}】${skill.description}`,
    '请严格按以下指令完成当前任务：',
    instructions,
  ];
  if (skill.allowedTools?.length) {
    lines.push('', `建议优先使用工具：${skill.allowedTools.join(', ')}。`);
  }
  return lines.join('\n');
}

export const PLAN_REQUEST_MARKER = '[[PLAN_REQUEST]]';

export function buildPlanRequest(task: string): string {
  return [
    `请为以下任务制定一个简洁的执行计划（TODO 列表）。${PLAN_REQUEST_MARKER}`,
    '',
    `任务：${task}`,
    '',
    '仅输出 JSON，格式为：{"steps":[{"title":"步骤描述"}, ...]}，不要输出多余文本。',
  ].join('\n');
}
