import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type {
  ChatRequest,
  ChatResponse,
  LLMProvider,
  Message,
  StreamHandler,
  ToolCall,
} from './types.js';
import { CAPPED_DEFAULT_MAX_TOKENS } from './context.js';

function toOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.toolCallId ?? '',
      };
    }
    if (m.role === 'assistant') {
      const base: ChatCompletionMessageParam = { role: 'assistant', content: m.content };
      if (m.toolCalls && m.toolCalls.length > 0) {
        (base as any).tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      return base;
    }
    if (m.role === 'system') return { role: 'system', content: m.content };
    return { role: 'user', content: m.content };
  });
}

function toOpenAITools(req: ChatRequest): ChatCompletionTool[] | undefined {
  if (!req.tools || req.tools.length === 0) return undefined;
  return req.tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = model;
  }

  async chat(request: ChatRequest, onDelta?: StreamHandler): Promise<ChatResponse> {
    const tools = toOpenAITools(request);
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(request.messages),
      tools,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? CAPPED_DEFAULT_MAX_TOKENS,
      stream: true,
    });

    let content = '';
    let finishReason: string | undefined;
    const toolAcc: Record<number, { id: string; name: string; arguments: string }> = {};

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (delta?.content) {
        content += delta.content;
        onDelta?.(delta.content);
      }
      const tcs = delta?.tool_calls;
      if (tcs) {
        for (const tc of tcs) {
          const idx = tc.index ?? 0;
          const cur = toolAcc[idx] ?? { id: '', name: '', arguments: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          toolAcc[idx] = cur;
        }
      }
    }

    const toolCalls: ToolCall[] = Object.values(toolAcc)
      .filter((t) => t.name)
      .map((t, i) => ({
        id: t.id || `call_${i}`,
        name: t.name,
        arguments: t.arguments || '{}',
      }));

    return { content, toolCalls, finishReason };
  }
}
