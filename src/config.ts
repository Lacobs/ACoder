import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CompressionConfig, CompressionMode } from './memory/compressor.js';
import { getAutoCompactThreshold } from './llm/context.js';

// 1) 优先加载当前工作目录的 .env（cwd 优先）
loadEnv();
// 2) 再加载包根的 .env 作为兜底（全局在任意目录运行时仍能读到项目配置），不覆盖 cwd 已有值
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: path.join(packageRoot, '.env'), override: false });

export type AgentMode = 'react' | 'plan' | 'auto';

export interface AppConfig {
  apiKey: string;
  baseURL: string | undefined;
  model: string;
  useMock: boolean;
  maxSteps: number;
  maxTokens: number;
  subagentMaxSteps: number;
  maxReflectRetries: number;
  contextLimit: number;
  commandTimeoutMs: number;
  defaultMode: AgentMode;
  workdir: string;
  compression: CompressionConfig;
}

function parseInt10(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseMode(value: string | undefined): AgentMode {
  if (value === 'react' || value === 'plan' || value === 'auto') return value;
  return 'auto';
}

function parseCompressionMode(value: string | undefined): CompressionMode {
  if (value === 'llm' || value === 'local' || value === 'hybrid') return value;
  return 'hybrid';
}

function resolveWorkdir(): string {
  const fromEnv = process.env.WORKDIR;
  // 默认以「当前所在目录」为沙箱根（像真正的 coding agent 操作当前项目）。
  const dir = fromEnv ? path.resolve(fromEnv) : process.cwd();
  if (fromEnv && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function loadConfig(): AppConfig {
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? '';
  const contextLimit = parseInt10(process.env.CONTEXT_LIMIT, 24);
  return {
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL?.trim() || undefined,
    model: process.env.MODEL?.trim() || 'gpt-4o-mini',
    useMock: apiKey.length === 0,
    maxSteps: parseInt10(process.env.MAX_STEPS, 40),
    maxTokens: parseInt10(process.env.MAX_TOKENS, 0),
    subagentMaxSteps: parseInt10(process.env.SUBAGENT_MAX_STEPS, 20),
    maxReflectRetries: parseInt10(process.env.MAX_REFLECT_RETRIES, 2),
    contextLimit,
    commandTimeoutMs: parseInt10(process.env.COMMAND_TIMEOUT_MS, 15000),
    defaultMode: parseMode(process.env.DEFAULT_MODE),
    workdir: resolveWorkdir(),
    compression: {
      mode: parseCompressionMode(process.env.COMPRESS_MODE),
      contextLimit,
      tokenThreshold: parseInt10(process.env.COMPRESS_TOKEN_THRESHOLD, getAutoCompactThreshold()),
      keepRecent: parseInt10(process.env.COMPRESS_KEEP_RECENT, 16),
      maxSummaryChars: parseInt10(process.env.COMPRESS_MAX_SUMMARY_CHARS, 2400),
    },
  };
}
