/**
 * 模型上下文窗口与预留预算（对齐 Claude Code 的 context.ts / autoCompact.ts 思路）。
 *
 * DeepSeek v4 flash 上下文窗口为 256K tokens（用户确认）。
 * token 估算沿用 chars/4 启发式，故各阈值按该口径取保守值并留安全余量。
 *
 * 预算分配：
 *   总窗口 256K
 *   - 预留输出/摘要        20K  → 有效窗口 236K
 *   - 预留压缩触发缓冲      16K  → 压缩触发阈值 ≈ 220K
 */
export const MODEL_CONTEXT_WINDOW = 256_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 16_000;

/** 单次请求默认输出上限：代码生成场景需要更大输出空间，避免整文件被截断（性能/成本平衡）。 */
export const CAPPED_DEFAULT_MAX_TOKENS = 16_000;

/** 有效可用窗口 = 总窗口 - 摘要预留。 */
export function getEffectiveContextWindow(): number {
  return MODEL_CONTEXT_WINDOW - MAX_OUTPUT_TOKENS_FOR_SUMMARY;
}

/** 触发自动压缩的 token 阈值 = 有效窗口 - 压缩缓冲。 */
export function getAutoCompactThreshold(): number {
  return getEffectiveContextWindow() - AUTOCOMPACT_BUFFER_TOKENS;
}
