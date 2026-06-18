import type { Message } from '../llm/types.js';
import type { MemoryOptions } from './types.js';
import { Compressor, estimateTokens, type CompressionStats, trimToValid } from './compressor.js';

/**
 * 会话记忆：维护消息历史与关键事实。
 * - 若注入了 Compressor：真正的压缩由推理循环在调用模型前 `await maybeCompact()` 触发（支持 LLM 摘要）。
 * - 若未注入 Compressor：在 add() 时退化为同步的本地条数裁剪兜底，保证旧路径不退化。
 */
export class Memory {
  private messages: Message[] = [];
  private facts: string[] = [];
  private contextLimit: number;
  private compressor?: Compressor;
  private lastStats: CompressionStats | null = null;
  private totalDropped = 0;

  constructor(opts: MemoryOptions, compressor?: Compressor) {
    this.contextLimit = opts.contextLimit;
    this.compressor = compressor;
  }

  add(message: Message): void {
    this.messages.push(message);
    // 无 compressor 时使用同步本地兜底；有 compressor 时压缩交由 maybeCompact 在 chat 前触发。
    if (!this.compressor) this.trimIfNeeded();
  }

  addMany(messages: Message[]): void {
    for (const m of messages) this.add(m);
  }

  /** 记录关键事实，便于跨任务复用。 */
  remember(fact: string): void {
    if (fact.trim()) this.facts.push(fact.trim());
  }

  getFacts(): string[] {
    return [...this.facts];
  }

  /** 返回用于发送给模型的消息列表。 */
  getMessages(): Message[] {
    return [...this.messages];
  }

  size(): number {
    return this.messages.length;
  }

  /** 估算 token 数（粗略：按字符/4，计入 tool_calls 参数）。 */
  approxTokens(): number {
    return estimateTokens(this.messages);
  }

  /**
   * 若有 compressor 且达到触发条件，则执行（可能是 LLM 的）压缩并替换历史，
   * 返回本次压缩统计；否则返回 null。
   */
  async maybeCompact(): Promise<CompressionStats | null> {
    if (!this.compressor) return null;
    if (!this.compressor.shouldCompress(this.messages)) return null;
    const { messages, stats } = await this.compressor.compress(this.messages);
    this.messages = messages;
    this.lastStats = stats;
    this.totalDropped += stats.droppedCount;
    return stats;
  }

  getLastStats(): CompressionStats | null {
    return this.lastStats;
  }

  getCompressionSummary(): { totalDropped: number; lastRatio: number | null } {
    return { totalDropped: this.totalDropped, lastRatio: this.lastStats?.ratio ?? null };
  }

  /** 无 compressor 时的同步本地兜底裁剪。 */
  private trimIfNeeded(): void {
    const system = this.messages.filter((m) => m.role === 'system');
    const rest = this.messages.filter((m) => m.role !== 'system');
    if (rest.length <= this.contextLimit) return;

    const keep = Math.max(4, Math.floor(this.contextLimit / 2));
    const dropped = rest.slice(0, rest.length - keep);
    const recent = trimToValid(rest.slice(rest.length - keep));

    const summary = summarizeDropped(dropped);
    const summaryMsg: Message = {
      role: 'system',
      content: `[上下文摘要] 已压缩 ${dropped.length} 条较早消息以节省上下文：\n${summary}`,
    };

    this.messages = [...system, summaryMsg, ...recent];
  }
}

/** 摘要被裁剪的消息：抽取工具调用与结果要点（本地兜底用）。 */
function summarizeDropped(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') lines.push(`- 用户: ${clip(m.content)}`);
    else if (m.role === 'tool') lines.push(`- 工具结果(${m.name ?? '?'}): ${clip(m.content)}`);
    else if (m.role === 'assistant' && m.toolCalls?.length) {
      lines.push(`- 助手调用: ${m.toolCalls.map((t) => t.name).join(', ')}`);
    }
  }
  return lines.slice(-12).join('\n') || '(无关键内容)';
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? t.slice(0, 120) + '…' : t;
}
