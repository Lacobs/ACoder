import { ToolRegistry } from './registry.js';
import { readFileTool, writeFileTool, editFileTool } from './file-tools.js';
import { listDirTool } from './list-dir-tool.js';
import { runCommandTool } from './run-command-tool.js';
import { analyzeCodeTool } from './analyze-code-tool.js';
import { searchContentTool } from './search-content-tool.js';
import { applyPatchTool } from './apply-patch-tool.js';
import { globTool } from './glob-tool.js';
import { gitDiffTool, gitStatusTool, gitLogTool, gitShowTool } from './git-tools.js';
import type { Tool } from './types.js';

export * from './types.js';
export { ToolRegistry } from './registry.js';

export const builtinTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  runCommandTool,
  analyzeCodeTool,
  searchContentTool,
  applyPatchTool,
  globTool,
  gitDiffTool,
  gitStatusTool,
  gitLogTool,
  gitShowTool,
];

export function createBaseRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(builtinTools);
  return registry;
}
