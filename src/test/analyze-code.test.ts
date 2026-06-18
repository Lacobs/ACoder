import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeCodeTool } from '../tools/analyze-code-tool.js';
import type { ToolContext } from '../tools/types.js';

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve(fn()).then(() => {
        passed += 1;
        console.log(`  \u2713 ${name}`);
    });
}

function tmpWorkdir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mca-analyze-'));
}

async function main(): Promise<void> {
    console.log('analyze_code 上下文检索测试：\n');

    const workdir = tmpWorkdir();
    const ctx: ToolContext = { workdir, commandTimeoutMs: 15000 };

    await check('命中结果附带前后上下文行与正确行号', async () => {
        const lines = [
            'const a = 1;',
            'const b = 2;',
            'export function target() {',
            '  return a + b;',
            '}',
        ].join('\n');
        fs.writeFileSync(path.join(workdir, 'src.ts'), lines);

        const res = await analyzeCodeTool.execute(
            { query: 'target', path: '.', regex: false, ignoreCase: false },
            ctx,
        );
        assert.equal(res.ok, true);
        // 命中行用 > 标记，且行号为 3
        assert.ok(res.output.includes('> 3|'));
        // 上下文包含前一行(2)与后一行(4)
        assert.ok(res.output.includes('2|'));
        assert.ok(res.output.includes('4|'));
        assert.equal((res.data as any).matches, 1);
    });

    await check('命中数超过展示上限时给出剩余提示', async () => {
        const many = Array.from({ length: 12 }, (_, i) => `hit_${i}`).join('\n');
        fs.writeFileSync(path.join(workdir, 'many.txt'), many);

        const res = await analyzeCodeTool.execute(
            { query: 'hit_', path: 'many.txt', regex: false, ignoreCase: false },
            ctx,
        );
        assert.equal(res.ok, true);
        assert.equal((res.data as any).matches, 12);
        assert.ok(res.output.includes('未展示'));
    });

    await check('文件首行命中时上下文不越界', async () => {
        fs.writeFileSync(path.join(workdir, 'head.txt'), 'firstHit\nsecond\nthird\n');
        const res = await analyzeCodeTool.execute(
            { query: 'firstHit', path: 'head.txt', regex: false, ignoreCase: false },
            ctx,
        );
        assert.equal(res.ok, true);
        assert.ok(res.output.includes('> 1|'));
    });

    console.log(`\n全部 ${passed} 项通过。analyze_code 验证完成。`);
}

main();
