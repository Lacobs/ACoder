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

/** 检查 tool call arguments 是否为合法 JSON；不合法时尝试修复（补闭合括号），仍失败返回 false。 */
function isValidOrFixableJson(json: string): string | null {
  if (!json || !json.trim()) return '{}';
  try {
    JSON.parse(json);
    return json;
  } catch {
    // 尝试补全未闭合的字符串与括号
    let fixed = json;
    // 统计未闭合的引号：奇数个双引号说明有字符串未闭合
    const quoteCount = (fixed.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) fixed += '"';
    // 统计括号深度
    let depth = 0;
    let inString = false;
    for (let i = 0; i < fixed.length; i++) {
      const c = fixed[i];
      if (c === '"' && fixed[i - 1] !== '\\') inString = !inString;
      if (inString) continue;
      if (c === '{' || c === '[') depth++;
      if (c === '}' || c === ']') depth--;
    }
    // 补闭合括号
    while (depth > 0) {
      // 判断最后一个未闭合的是 { 还是 [
      const lastOpen = fixed.lastIndexOf('{') > fixed.lastIndexOf('[') ? '}' : ']';
      fixed += lastOpen;
      depth--;
    }
    try {
      JSON.parse(fixed);
      return fixed;
    } catch {
      return null;
    }
  }
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

    // 流结束后修复可能截断的 tool call arguments
    const toolCalls: ToolCall[] = [];
    for (const [idx, t] of Object.entries(toolAcc)) {
      if (!t.name) continue;
      const fixed = isValidOrFixableJson(t.arguments);
      if (fixed !== null) {
        toolCalls.push({
          id: t.id || `call_${idx}`,
          name: t.name,
          arguments: fixed,
        });
      } else {
        // 无法修复的截断，标记为失败
        toolCalls.push({
          id: t.id || `call_${idx}`,
          name: t.name,
          arguments: JSON.stringify({
            _error: 'tool_call_arguments_truncated',
            _raw: t.arguments.slice(0, 200),
          }),
        });
        // 追加截断提示到 content
        content += `\n[警告] 工具调用 ${t.name} 的参数 JSON 因流式截断而无法解析，请重试。`;
      }
    }

    return { content, toolCalls, finishReason };
  }
}
