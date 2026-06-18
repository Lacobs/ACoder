import type { LLMProvider } from '../llm/types.js';
import { Memory } from './memory.js';
import { Compressor, type CompressionConfig } from './compressor.js';

export * from './types.js';
export { Memory } from './memory.js';
export { Budget } from './budget.js';
export {
  Compressor,
  estimateTokens,
  localSummarize,
  trimToValid,
  DEFAULT_COMPRESSION,
} from './compressor.js';
export type { CompressionConfig, CompressionMode, CompressionStats } from './compressor.js';
export {
  getMemoryDir,
  ensureMemoryDir,
  buildMemoryPrompt,
  readEntrypoint,
  truncateEntrypoint,
  MEMORY_SUBDIR,
  ENTRYPOINT_NAME,
} from './persistent.js';

/** 创建一个带压缩能力的 Memory（注入 Compressor）。 */
export function createMemory(provider: LLMProvider | undefined, cfg: CompressionConfig): Memory {
  const compressor = new Compressor(provider, cfg);
  return new Memory({ contextLimit: cfg.contextLimit }, compressor);
}
