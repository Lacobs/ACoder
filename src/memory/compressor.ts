import type { LLMProvider, Message } from '../llm/types.js';

export type CompressionMode = 'llm' | 'local' | 'hybrid';

export interface CompressionConfig {
  /** 压缩策略：llm=语义摘要；local=本地确定性压缩；hybrid=LLM 优先、失败回退本地。 */
  mode: CompressionMode;
  /** 非 system 消息条数阈值，超过即触发压缩。 */
  contextLimit: number;
  /** 估算 token 阈值，超过即触发压缩。 */
  tokenThreshold: number;
  /** 压缩时保留最近 N 条原文消息。 */
  keepRecent: number;
  /** 摘要体积上限（字符），控制压缩比。 */
  maxSummaryChars: number;
}

export interface CompressionStats {
  mode: CompressionMode;
  beforeTokens: number;
  afterTokens: number;
  /** afterTokens / beforeTokens，越小压缩越极致。 */
  ratio: number;
  droppedCount: number;
}

export const DEFAULT_COMPRESSION: CompressionConfig = {
  mode: 'hybrid',
  contextLimit: 24,
  tokenThreshold: 1200,
  keepRecent: 6,
  maxSummaryChars: 600,
};

/** 估算单条消息的字符体积，包含 assistant 的 tool_calls 参数体。 */
function messageChars(m: Message): number {
  let chars = m.content?.length ?? 0;
  if (m.toolCalls?.length) {
    for (const t of m.toolCalls) {
      chars += (t.name?.length ?? 0) + (t.arguments?.length ?? 0);
    }
  }
  return chars;
}

/** 估算一组消息的 token 数（粗略：字符/4，计入 tool_calls 参数）。 */
export function estimateTokens(messages: Message[]): number {
  const chars = messages.reduce((acc, m) => acc + messageChars(m), 0);
  return Math.ceil(chars / 4);
}

/**
 * 上下文压缩器：把较早的对话历史压成一条结构化摘要，
 * 保留 system 提示与最近窗口，最大限度减少体积同时保住可继续任务的关键信息。
 */
export class Compressor {
  constructor(
    private provider: LLMProvider | undefined,
    private cfg: CompressionConfig,
  ) { }

  get config(): CompressionConfig {
    return this.cfg;
  }

  shouldCompress(messages: Message[]): boolean {
    const nonSystem = messages.filter((m) => m.role !== 'system');
    if (nonSystem.length <= this.cfg.keepRecent) return false;
    return nonSystem.length > this.cfg.contextLimit || estimateTokens(messages) > this.cfg.tokenThreshold;
  }

  async compress(messages: Message[]): Promise<{ messages: Message[]; stats: CompressionStats }> {
    const beforeTokens = estimateTokens(messages);
    const system = messages.filter((m) => m.role === 'system');
    const rest = messages.filter((m) => m.role !== 'system');

    const recent = trimToValid(rest.slice(-this.cfg.keepRecent));
    const dropped = rest.slice(0, rest.length - recent.length);

    // 候选摘要正文：本地一版；如启用 LLM 再尝试一版。择优（更短者）使用。
    const candidates: string[] = [];
    if (dropped.length === 0) {
      candidates.push('(无可压缩的更早历史)');
    } else {
      const local = localSummarize(dropped, this.cfg.maxSummaryChars);
      if (this.cfg.mode === 'local') {
        candidates.push(local);
      } else {
        const llm = await this.llmSummarize(dropped).catch(() => '');
        if (llm) candidates.push(llm);
        candidates.push(local); // 始终保留本地候选作为兜底
      }
    }

    // 选出使整体最小的摘要正文
    let best = pickSmallest(system, recent, candidates);

    let compacted = [...system, makeSummaryMsg(dropped.length, best), ...recent];
    let afterTokens = estimateTokens(compacted);

    // 保证压缩不会反而增大：若仍 >= 原始，丢弃摘要，仅保留 system + recent
    if (afterTokens >= beforeTokens) {
      compacted = [...system, ...recent];
      afterTokens = estimateTokens(compacted);
    }

    const stats: CompressionStats = {
      mode: this.cfg.mode,
      beforeTokens,
      afterTokens,
      ratio: beforeTokens > 0 ? afterTokens / beforeTokens : 1,
      droppedCount: dropped.length,
    };
    return { messages: compacted, stats };
  }

  private async llmSummarize(dropped: Message[]): Promise<string> {
    if (!this.provider || this.provider.name === 'mock') {
      // Mock 无法产出有意义摘要 → 触发回退
      throw new Error('no-usable-llm');
    }
    const transcript = dropped
      .map((m) => {
        if (m.role === 'assistant' && m.toolCalls?.length) {
          return `assistant 调用工具: ${m.toolCalls.map((t) => `${t.name}(${t.arguments})`).join('; ')}`;
        }
        return `${m.role}${m.name ? `(${m.name})` : ''}: ${m.content}`;
      })
      .join('\n');

    const prompt = [
      `请在不超过 ${this.cfg.maxSummaryChars} 字内，对以下对话历史做极致压缩摘要。`,
      '要求：最大限度保留可继续任务的关键信息——总体目标、关键事实、涉及的文件/路径、工具调用得到的结论、尚未完成的事项；',
      '丢弃寒暄、重复与无关细节。直接输出摘要正文，不要解释。',
      '',
      '=== 对话历史 ===',
      transcript,
    ].join('\n');

    const res = await this.provider.chat({
      messages: [
        { role: 'system', content: '你是一个上下文压缩器，擅长在极少字数内保留关键信息。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
    });
    const text = (res.content || '').trim();
    if (!text) throw new Error('empty-summary');
    return text.length > this.cfg.maxSummaryChars ? text.slice(0, this.cfg.maxSummaryChars) + '…' : text;
  }
}

/** 本地确定性压缩：抽取意图/工具序列/结果要点/结论/涉及文件/未完成事项，去重并截断。 */
export function localSummarize(messages: Message[], maxChars: number): string {
  const intents: string[] = [];
  const toolCalls: string[] = [];
  const toolResults: string[] = [];
  const conclusions: string[] = [];
  const files = new Set<string>();
  const todos: string[] = [];

  for (const m of messages) {
    collectFiles(m.content, files);
    if (m.role === 'user') {
      intents.push(clip(m.content, 100));
      collectTodos(m.content, todos);
    } else if (m.role === 'tool') {
      toolResults.push(`${m.name ?? '?'}: ${clip(m.content, 100)}`);
    } else if (m.role === 'assistant') {
      if (m.toolCalls?.length) {
        toolCalls.push(m.toolCalls.map((t) => t.name).join(', '));
        for (const t of m.toolCalls) collectFiles(t.arguments, files);
      } else if (m.content) {
        conclusions.push(clip(m.content, 120));
        collectTodos(m.content, todos);
      }
    }
  }

  const sections: string[] = [];
  if (intents.length) sections.push(`• 用户意图: ${dedupe(intents).slice(-4).join(' | ')}`);
  if (files.size) sections.push(`• 涉及文件/路径: ${[...files].slice(-10).join(', ')}`);
  if (toolCalls.length) sections.push(`• 工具调用序列: ${dedupe(toolCalls).slice(-8).join(' → ')}`);
  if (toolResults.length) sections.push(`• 工具结果要点:\n${dedupe(toolResults).slice(-8).map((s) => `  - ${s}`).join('\n')}`);
  if (conclusions.length) sections.push(`• 已得结论: ${dedupe(conclusions).slice(-3).join(' | ')}`);
  if (todos.length) sections.push(`• 未完成事项: ${dedupe(todos).slice(-4).join(' | ')}`);

  const out = sections.join('\n') || '(无关键内容)';
  return out.length > maxChars ? out.slice(0, maxChars) + '…' : out;
}

/** 从文本中提取疑似文件/路径（含目录分隔符或常见源码后缀），加入集合。 */
function collectFiles(text: string | undefined, into: Set<string>): void {
  if (!text) return;
  const re = /[\w./\-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|c|cpp|h|css|html|yml|yaml|toml|env)\b|[\w\-]+\/[\w./\-]+/g;
  const matches = text.match(re);
  if (!matches) return;
  for (const f of matches.slice(0, 20)) into.add(f);
}

/** 从文本中提取「未完成/待办」线索。 */
function collectTodos(text: string | undefined, into: string[]): void {
  if (!text) return;
  for (const line of text.split('\n')) {
    if (/TODO|待办|未完成|尚未|还需|接下来|next step|remaining/i.test(line)) {
      into.push(clip(line, 100));
    }
  }
}

function makeSummaryMsg(droppedCount: number, body: string): Message {
  return {
    role: 'system',
    content: `[上下文压缩摘要] 已将 ${droppedCount} 条较早消息压缩如下（保留关键信息）：\n${body}`,
  };
}

/** 在多个候选摘要正文中，选出使整体 token 最小的那个。 */
function pickSmallest(system: Message[], recent: Message[], candidates: string[]): string {
  let best = candidates[0] ?? '(无关键内容)';
  let bestTokens = Infinity;
  for (const body of candidates) {
    const tokens = estimateTokens([...system, makeSummaryMsg(0, body), ...recent]);
    if (tokens < bestTokens) {
      bestTokens = tokens;
      best = body;
    }
  }
  return best;
}

/**
 * 确保裁剪后的最近消息序列不会以悬空的 tool 消息开头
 * （tool 消息必须紧跟在含 tool_calls 的 assistant 消息之后，否则部分 API 会报错）。
 */
export function trimToValid(messages: Message[]): Message[] {
  const result = [...messages];
  while (result.length > 0 && result[0].role === 'tool') {
    result.shift();
  }
  return result;
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

function clip(s: string, max: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}
