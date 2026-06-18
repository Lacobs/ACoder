import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getMemoryDir,
  buildMemoryPrompt,
  truncateEntrypoint,
  ENTRYPOINT_NAME,
  MEMORY_SUBDIR,
  MAX_ENTRYPOINT_LINES,
} from '../memory/persistent.js';
import {
  getAutoCompactThreshold,
  getEffectiveContextWindow,
  MODEL_CONTEXT_WINDOW,
} from '../llm/context.js';
import { localSummarize } from '../memory/compressor.js';
import type { Message } from '../llm/types.js';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  \u2713 ${name}`);
}

function tmpWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mca-mem-'));
}

function main(): void {
  console.log('记忆与上下文配置验证测试：\n');

  check('getMemoryDir 指向 <workdir>/.mca/memory', () => {
    const wd = '/tmp/proj';
    assert.equal(getMemoryDir(wd), path.join(wd, MEMORY_SUBDIR));
  });

  check('buildMemoryPrompt：自动创建记忆目录与入口文件', () => {
    const wd = tmpWorkdir();
    const dir = getMemoryDir(wd);
    const out = buildMemoryPrompt(dir);
    assert.ok(fs.existsSync(dir), '记忆目录应被创建');
    assert.ok(fs.existsSync(path.join(dir, ENTRYPOINT_NAME)), 'MEMORY.md 应被创建');
    assert.ok(out.includes(ENTRYPOINT_NAME));
    assert.ok(out.includes('双步写入法'));
  });

  check('buildMemoryPrompt：MEMORY.md 存在时注入其内容', () => {
    const wd = tmpWorkdir();
    const dir = getMemoryDir(wd);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ENTRYPOINT_NAME), '- [偏好](pref.md) 用户偏好中文');
    const out = buildMemoryPrompt(dir);
    assert.ok(out.includes('用户偏好中文'));
  });

  check('truncateEntrypoint：超过 200 行时硬截断', () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const { content, truncated } = truncateEntrypoint(big);
    assert.equal(truncated, true);
    assert.ok(content.split('\n').length <= MAX_ENTRYPOINT_LINES);
  });

  check('上下文阈值推导：256K 窗口 → 有效 236K → 触发 220K', () => {
    assert.equal(MODEL_CONTEXT_WINDOW, 256_000);
    assert.equal(getEffectiveContextWindow(), 236_000);
    assert.equal(getAutoCompactThreshold(), 220_000);
  });

  check('localSummarize 保留涉及文件/路径与未完成事项', () => {
    const msgs: Message[] = [
      { role: 'user', content: '请修改 src/agent/loop.ts，注意还需补充测试。' },
      {
        role: 'assistant',
        content: '已读取',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"src/config.ts"}' }],
      },
      { role: 'tool', name: 'read_file', toolCallId: 'c1', content: '内容' },
      { role: 'assistant', content: 'TODO: 还需要运行构建验证。' },
    ];
    const out = localSummarize(msgs, 2000);
    assert.ok(out.includes('涉及文件/路径'));
    assert.ok(out.includes('src/agent/loop.ts'));
    assert.ok(out.includes('未完成事项'));
  });

  console.log(`\n全部 ${passed} 项通过。记忆与上下文配置验证完成。`);
}

main();
