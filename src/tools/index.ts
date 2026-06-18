import { ToolRegistry } from './registry.js';
import { readFileTool, writeFileTool, editFileTool } from './file-tools.js';
import { listDirTool } from './list-dir-tool.js';
import { runCommandTool } from './run-command-tool.js';
import { analyzeCodeTool } from './analyze-code-tool.js';
import type { Tool } from './types.js';

export * from './types.js';
export { ToolRegistry } from './registry.js';

export const builtinTools: Tool[] = [
  readFileTool,
  writeFileTool,
  listDirTool,
  runCommandTool,
  analyzeCodeTool,
];

export function createBaseRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(builtinTools);
  return registry;
}
