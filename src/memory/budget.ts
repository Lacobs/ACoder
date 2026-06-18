import type { BudgetSnapshot } from './types.js';

/** 步数 / token 预算计量器，供主代理与子代理共用。 */
export class Budget {
  private steps = 0;
  private tokens = 0;
  readonly maxSteps: number;
  /** 累计 token 上限（粗略成本护栏）；0 表示不限制。 */
  readonly maxTokens: number;

  constructor(maxSteps: number, maxTokens = 0) {
    this.maxSteps = maxSteps;
    this.maxTokens = Math.max(0, maxTokens);
  }

  /** 消耗一步，返回是否仍在预算内（步数与 token 任一超限即返回 false）。 */
  consumeStep(): boolean {
    this.steps += 1;
    return !this.exhausted();
  }

  /** 累计本轮发送的 token（用于粗略成本计量与护栏）。 */
  addTokens(n: number): void {
    this.tokens += Math.max(0, n);
  }

  get currentStep(): number {
    return this.steps;
  }

  get currentTokens(): number {
    return this.tokens;
  }

  /** token 预算是否已耗尽（仅在设置了 maxTokens 时生效）。 */
  tokensExhausted(): boolean {
    return this.maxTokens > 0 && this.tokens >= this.maxTokens;
  }

  exhausted(): boolean {
    return this.steps >= this.maxSteps || this.tokensExhausted();
  }

  snapshot(): BudgetSnapshot {
    return { steps: this.steps, maxSteps: this.maxSteps, approxTokens: this.tokens };
  }
}
