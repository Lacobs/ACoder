import type { Message } from '../llm/types.js';

export interface MemoryOptions {
    /** Number of non-system messages beyond which trimming/summary kicks in. */
    contextLimit: number;
}

export interface BudgetSnapshot {
    steps: number;
    maxSteps: number;
    approxTokens: number;
}

export type { Message };
