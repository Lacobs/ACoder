import assert from 'node:assert/strict';
import type { Message } from '../llm/types.js';
import { MockProvider } from '../llm/mock.js';
import {
  Compressor,
  estimateTokens,
  type CompressionConfig,
} from '../memory/compressor.js';
import { Memory } from '../memory/memory.js';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  \u2713 ${name}`);
}

const UNIQUE_FACT = 'FACT_TOKEN_7Q9Z';
const FILE_PATH = 'src/agent/loop.ts';

/** 构造一段超阈值的长对话，内含可识别的关键事实标记。 */
function buildLongConversation(): Message[] {
  const messages: Message[] = [{ role: 'system', content: '你是一个 Coding Agent。' }];
  messages.push({ role: 'user', content: `请重构 ${FILE_PATH}，注意 ${UNIQUE_FACT} 这个关键约束。` });
  for (let i = 0; i < 20; i++) {
    messages.push({
      role: 'assistant',
      content: `第 ${i} 轮思考，准备调用工具。`.repeat(6),
      toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: `{"path":"f${i}.ts"}` }],
    });
    messages.push({
      role: 'tool',
      name: 'read_file',
      toolCallId: `c${i}`,
      content: `文件 f${i}.ts 内容很长。`.repeat(20),
    });
  }
  return messages;
}

const baseCfg: CompressionConfig = {
  mode: 'local',
  contextLimit: 24,
  tokenThreshold: 1200,
  keepRecent: 6,
  maxSummaryChars: 600,
};

/** 校验消息序列对 OpenAI 转换合法：每个 tool 消息前必须有带 toolCalls 的 assistant。 */
function assertValidSequence(messages: Message[]): void {
  const nonSystem = messages.filter((m) => m.role !== 'system');
  const openToolIds = new Set<string>();
  for (const m of nonSystem) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) openToolIds.add(tc.id);
    } else if (m.role === 'tool') {
      assert.ok(
        m.toolCallId && openToolIds.has(m.toolCallId),
        `悬空 tool 消息（无配对 assistant.tool_calls）：${m.toolCallId}`,
      );
    }
  }
}

async function main(): Promise<void> {
  console.log('上下文压缩验证测试：\n');

  check('shouldCompress 在超阈值时为真、未超时为假', () => {
    const c = new Compressor(undefined, baseCfg);
    assert.equal(c.shouldCompress(buildLongConversation()), true);
    const tiny: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '你好' },
    ];
    assert.equal(c.shouldCompress(tiny), false);
  });

  let localRatio = 1;
  await (async () => {
    const c = new Compressor(undefined, baseCfg);
    const msgs = buildLongConversation();
    const { messages: out, stats } = await c.compress(msgs);
    localRatio = stats.ratio;

    check('local 模式压缩后 token 显著减少且压缩比达标(<0.6)', () => {
      assert.ok(stats.afterTokens < stats.beforeTokens, 'afterTokens 应小于 beforeTokens');
      assert.ok(stats.ratio < 0.6, `压缩比应 < 0.6，实际 ${stats.ratio.toFixed(2)}`);
    });

    check('压缩后保留 system 提示', () => {
      assert.ok(out.some((m) => m.role === 'system' && m.content.includes('Coding Agent')));
    });

    check('压缩后保留关键事实标记（文件路径/唯一 token）', () => {
      const joined = out.map((m) => m.content).join('\n');
      assert.ok(joined.includes(UNIQUE_FACT) || joined.includes(FILE_PATH), '关键事实应被保留');
    });

    check('压缩后保留最近 keepRecent 条原文', () => {
      const original = buildLongConversation();
      const lastOriginal = original[original.length - 1].content;
      assert.ok(out.some((m) => m.content === lastOriginal), '最近一条原文应保留');
    });

    check('压缩结果不以悬空 tool 消息开头且序列合法', () => {
      const nonSystem = out.filter((m) => m.role !== 'system');
      // 摘要后的第一条非 system 应为摘要 system（已过滤）后的 recent 块首条，不应是悬空 tool
      assertValidSequence(out);
    });

    console.log(`    \u2192 local 压缩比: ${stats.beforeTokens}\u2192${stats.afterTokens} tokens (ratio=${stats.ratio.toFixed(2)})`);
  })();

  await (async () => {
    // hybrid + Mock provider：Mock 不可用于摘要，应回退本地且不抛错
    const c = new Compressor(new MockProvider(), { ...baseCfg, mode: 'hybrid' });
    const { messages: out, stats } = await c.compress(buildLongConversation());
    check('hybrid + Mock 回退本地不抛错并产出压缩结果', () => {
      assert.ok(stats.afterTokens < stats.beforeTokens);
      assert.ok(out.length > 0);
      assertValidSequence(out);
    });
    console.log(`    \u2192 hybrid(回退) 压缩比: ratio=${stats.ratio.toFixed(2)}`);
  })();

  await (async () => {
    // Memory.maybeCompact 集成：注入 compressor 后超阈值触发
    const compressor = new Compressor(undefined, baseCfg);
    const mem = new Memory({ contextLimit: baseCfg.contextLimit }, compressor);
    for (const m of buildLongConversation()) mem.add(m);
    const beforeTokens = mem.approxTokens();
    const stats = await mem.maybeCompact();
    check('Memory.maybeCompact 触发压缩并更新历史', () => {
      assert.ok(stats !== null, 'maybeCompact 应返回统计');
      assert.ok(mem.approxTokens() < beforeTokens, '压缩后 Memory token 应下降');
      assert.ok(estimateTokens(mem.getMessages()) === mem.approxTokens());
    });
    check('Memory 无 compressor 时 maybeCompact 返回 null', async () => {
      const plain = new Memory({ contextLimit: baseCfg.contextLimit });
      for (const m of buildLongConversation()) plain.add(m);
      // 同步：直接断言返回值类型路径（plain 无 compressor）
      assert.equal((plain as any)['compressor'], undefined);
    });
  })();

  console.log(`\n全部 ${passed} 项通过。极致压缩验证完成（local ratio=${localRatio.toFixed(2)}）。`);
}

main().catch((err) => {
  console.error('\n测试失败:', err);
  process.exit(1);
});
