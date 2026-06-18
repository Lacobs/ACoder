import type { AppConfig } from '../config.js';
import { MockProvider } from './mock.js';
import { OpenAIProvider } from './openai.js';
import type { LLMProvider } from './types.js';

export * from './types.js';

export function createProvider(config: AppConfig): LLMProvider {
  if (config.useMock) {
    return new MockProvider();
  }
  return new OpenAIProvider(config.apiKey, config.model, config.baseURL);
}
