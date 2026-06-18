import type { ToolSchema } from '../llm/types.js';
import { toToolSchema, type Tool, type ToolContext, type ToolResult } from './types.js';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Return a subset registry filtered by allowed names (for sub-agents/skills). */
  subset(names: string[]): ToolRegistry {
    const r = new ToolRegistry();
    for (const n of names) {
      const t = this.tools.get(n);
      if (t) r.register(t);
    }
    return r;
  }

  schemas(): ToolSchema[] {
    return this.list().map(toToolSchema);
  }

  async execute(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: `未知工具: ${name}` };
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = rawArgs && rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return { ok: false, output: `工具 ${name} 的参数不是合法 JSON: ${rawArgs}` };
    }

    const validation = tool.parameters.safeParse(parsedArgs);
    if (!validation.success) {
      const issues = validation.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { ok: false, output: `参数校验失败 [${name}]: ${issues}` };
    }

    try {
      return await tool.execute(validation.data, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `工具执行异常 [${name}]: ${msg}` };
    }
  }
}
