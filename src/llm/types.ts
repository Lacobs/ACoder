export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
    id: string;
    name: string;
    /** Raw JSON string of arguments, as returned by the model. */
    arguments: string;
}

export interface Message {
    role: Role;
    content: string;
    /** Present on assistant messages that request tool calls. */
    toolCalls?: ToolCall[];
    /** Present on tool messages: which tool call this responds to. */
    toolCallId?: string;
    /** Optional human-readable name (e.g. tool name on tool messages). */
    name?: string;
}

/** A tool exposed to the model, in a provider-agnostic shape. */
export interface ToolSchema {
    name: string;
    description: string;
    /** JSON-Schema object describing parameters. */
    parameters: Record<string, unknown>;
}

export interface ChatRequest {
    messages: Message[];
    tools?: ToolSchema[];
    /** Optional temperature override. */
    temperature?: number;
    /** Optional max output tokens override. */
    maxTokens?: number;
}

export interface ChatResponse {
    content: string;
    toolCalls: ToolCall[];
    usage?: { promptTokens?: number; completionTokens?: number };
    /** 模型停止原因，'length' 表示因达到 max_tokens 被截断。 */
    finishReason?: string;
}

/** Callback used for streaming token deltas of assistant text. */
export type StreamHandler = (delta: string) => void;

export interface LLMProvider {
    readonly name: string;
    chat(request: ChatRequest, onDelta?: StreamHandler): Promise<ChatResponse>;
}
