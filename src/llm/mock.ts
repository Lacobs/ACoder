import type {
    ChatRequest,
    ChatResponse,
    LLMProvider,
    Message,
    StreamHandler,
    ToolCall,
} from './types.js';

/**
 * 离线 Mock 模型：无需 API Key 即可驱动 ReAct / Plan / 子代理三类场景。
 * 通过关键字启发式 + 已执行工具步数，确定性地推进对话直到产出最终答复。
 */

interface PlannedCall {
    name: string;
    args: Record<string, unknown>;
}

function firstUserTask(messages: Message[]): string {
    const u = messages.find((m) => m.role === 'user');
    return u?.content ?? '';
}

function countToolMessages(messages: Message[]): number {
    return messages.filter((m) => m.role === 'tool').length;
}

function latestContent(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const c = messages[i]?.content;
        if (c) return c;
    }
    return '';
}

function extractFilename(task: string, fallback: string): string {
    const m = task.match(/([\w./-]+\.\w+)/);
    return m ? m[1] : fallback;
}

function has(task: string, words: string[]): boolean {
    return words.some((w) => task.includes(w));
}

/** 构造一个 JSON 计划（Plan 模式）。 */
function buildPlan(task: string): string {
    const steps: { title: string }[] = [];
    if (has(task, ['写入', '创建', '新增', '生成文件', 'hello'])) {
        steps.push({ title: `创建并写入文件 ${extractFilename(task, 'hello.txt')}` });
    }
    if (has(task, ['列出', '目录', 'list', '确认'])) {
        steps.push({ title: '列出工作目录以确认结果' });
    }
    if (has(task, ['分析', '检索', '审查', '搜索', '统计'])) {
        steps.push({ title: '分析代码结构并汇总要点' });
    }
    if (has(task, ['读取', '总结', 'README'])) {
        steps.push({ title: `读取文件 ${extractFilename(task, 'README.md')} 并总结` });
    }
    if (steps.length === 0) {
        steps.push({ title: '收集任务所需的上下文信息' });
        steps.push({ title: '执行核心操作并产出结果' });
    }
    steps.push({ title: '汇总所有步骤的结果并给出结论' });
    return JSON.stringify({ steps });
}

/** 针对单个（子）对话，按关键字推导有序动作序列。 */
function buildActionSequence(task: string, toolNames: Set<string>): PlannedCall[] {
    const seq: PlannedCall[] = [];

    const canDelegate =
        toolNames.has('spawn_subagent') &&
        has(task, ['子任务', '拆分', '并行', '调研', '多个']) &&
        has(task, ['审查', '调研', '分析', '质量', '结构']);

    if (canDelegate) {
        seq.push({
            name: 'spawn_subagent',
            args: {
                task: '调研当前项目的目录结构与关键文件，给出结构概览',
                tools: ['list_dir', 'read_file', 'analyze_code'],
            },
        });
        seq.push({
            name: 'spawn_subagent',
            args: {
                task: '审查项目代码质量，指出潜在问题与改进点',
                tools: ['analyze_code', 'read_file'],
            },
        });
        return seq;
    }

    if (has(task, ['列出', '目录', '结构', 'list', '概览'])) {
        if (toolNames.has('list_dir')) seq.push({ name: 'list_dir', args: { path: '.' } });
    }
    if (has(task, ['读取', '总结', 'README', '查看文件'])) {
        if (toolNames.has('read_file')) {
            seq.push({ name: 'read_file', args: { path: extractFilename(task, 'README.md') } });
        }
    }
    if (has(task, ['写入', '创建', '新增', 'hello', '生成文件'])) {
        if (toolNames.has('write_file')) {
            seq.push({
                name: 'write_file',
                args: {
                    path: extractFilename(task, 'hello.txt'),
                    content: '你好，欢迎使用 ACoder！\nHello from the mock agent.\n',
                },
            });
        }
    }
    if (has(task, ['列出', '确认', '目录']) && toolNames.has('list_dir')) {
        if (!seq.some((s) => s.name === 'list_dir')) seq.push({ name: 'list_dir', args: { path: '.' } });
    }
    if (has(task, ['分析', '检索', '审查', '搜索', '统计', '质量', '代码'])) {
        if (toolNames.has('analyze_code')) {
            seq.push({ name: 'analyze_code', args: { query: 'function' } });
        }
    }
    if (has(task, ['运行', '执行命令', 'command', '命令']) && toolNames.has('run_command')) {
        seq.push({ name: 'run_command', args: { command: 'echo mock-run-ok' } });
    }

    if (seq.length === 0 && toolNames.has('list_dir')) {
        seq.push({ name: 'list_dir', args: { path: '.' } });
    }
    return seq;
}

function summarize(task: string, messages: Message[]): string {
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    const used = [...new Set(toolMsgs.map((m) => m.name).filter(Boolean))].join(', ');
    const evidence =
        toolMsgs.length > 0
            ? `我依据 ${toolMsgs.length} 次工具调用（${used || 'n/a'}）的结果得出结论。`
            : '我基于已有上下文得出结论。';
    return [
        `任务「${task.slice(0, 60)}${task.length > 60 ? '…' : ''}」已完成。`,
        evidence,
        '（注：当前为离线 Mock 模型输出，仅用于演示 Agent 运行流程。配置 OPENAI_API_KEY 可接入真实模型。）',
    ].join('\n');
}

export class MockProvider implements LLMProvider {
    readonly name = 'mock';

    async chat(request: ChatRequest, onDelta?: StreamHandler): Promise<ChatResponse> {
        const { messages, tools } = request;
        const task = firstUserTask(messages);
        const last = latestContent(messages);

        // Plan 创建请求
        if (last.includes('[[PLAN_REQUEST]]')) {
            const content = buildPlan(task);
            await emit(content, onDelta);
            return { content, toolCalls: [] };
        }

        const toolNames = new Set((tools ?? []).map((t) => t.name));
        const seq = buildActionSequence(task, toolNames);
        const done = countToolMessages(messages);

        if (done < seq.length) {
            const next = seq[done];
            const thinking = `思考：下一步调用 ${next.name} 来推进任务。`;
            await emit(thinking, onDelta);
            const toolCalls: ToolCall[] = [
                { id: `mock_${done}`, name: next.name, arguments: JSON.stringify(next.args) },
            ];
            return { content: thinking, toolCalls };
        }

        const content = summarize(task, messages);
        await emit(content, onDelta);
        return { content, toolCalls: [] };
    }
}

async function emit(text: string, onDelta?: StreamHandler): Promise<void> {
    if (!onDelta) return;
    // 模拟流式输出：按片段逐步推送
    const chunks = text.match(/[\s\S]{1,8}/g) ?? [text];
    for (const c of chunks) {
        onDelta(c);
        await new Promise((r) => setTimeout(r, 6));
    }
}
