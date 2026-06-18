import { z } from 'zod';
import type { ToolSchema } from '../llm/types.js';

export interface ToolContext {
  /** Absolute path to the sandboxed working directory. */
  workdir: string;
  /** Command execution timeout in ms. */
  commandTimeoutMs: number;
}

export interface ToolResult {
  ok: boolean;
  /** Human/agent-readable result text. */
  output: string;
  /** Optional structured data. */
  data?: unknown;
}

export interface Tool<TParams = any> {
  name: string;
  description: string;
  parameters: z.ZodType<TParams>;
  execute(args: TParams, ctx: ToolContext): Promise<ToolResult>;
}

/** Minimal Zod -> JSON Schema converter sufficient for tool params. */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return convert(schema);
}

function convert(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def;
  const typeName = def?.typeName as string | undefined;

  switch (typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodArray':
      return { type: 'array', items: convert(def.type) };
    case 'ZodOptional':
      return convert(def.innerType);
    case 'ZodDefault':
      return convert(def.innerType);
    case 'ZodObject': {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const v = value as z.ZodTypeAny;
        properties[key] = withDescription(v, convert(v));
        if (!isOptional(v)) required.push(key);
      }
      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
    }
    default:
      return { type: 'string' };
  }
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const tn = schema._def?.typeName;
  return tn === 'ZodOptional' || tn === 'ZodDefault';
}

function withDescription(schema: z.ZodTypeAny, json: Record<string, unknown>): Record<string, unknown> {
  const desc = schema._def?.description;
  return desc ? { ...json, description: desc } : json;
}

export function toToolSchema(tool: Tool): ToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.parameters),
  };
}
