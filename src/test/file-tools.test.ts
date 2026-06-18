import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileTool, writeFileTool, editFileTool } from '../tools/file-tools.js';
import type { ToolContext } from '../tools/types.js';

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  });
}

function tmpWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mca-filetools-'));
}

async function main(): Promise<void> {
  console.log('文件工具验证测试：\n');

  const workdir = tmpWorkdir();
  const ctx: ToolContext = { workdir, commandTimeoutMs: 15000 };

  await check('read_file 输出带行号与文件头信息', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    fs.writeFileSync(path.join(workdir, 'a.txt'), lines);
    const res = await readFileTool.execute({ path: 'a.txt' }, ctx);
    assert.equal(res.ok, true);
    assert.ok(res.output.includes('共 10 行'));
    assert.ok(res.output.includes('1\u2192line1'));
    assert.ok(res.output.includes('10\u2192line10'));
  });

  await check('read_file 分页 offset/limit 与继续读取提示', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join('\n');
    fs.writeFileSync(path.join(workdir, 'big.txt'), lines);
    const res = await readFileTool.execute({ path: 'big.txt', offset: 11, limit: 10 }, ctx);
    assert.equal(res.ok, true);
    assert.ok(res.output.includes('11\u2192L11'));
    assert.ok(res.output.includes('20\u2192L20'));
    assert.ok(!res.output.includes('\u2192L21'));
    assert.ok(res.output.includes('使用 offset=21 继续读取'));
    assert.equal((res.data as any).totalLines, 50);
  });

  await check('edit_file 唯一匹配替换成功且其余内容不变', async () => {
    fs.writeFileSync(path.join(workdir, 'edit.txt'), 'alpha\nbeta\ngamma\n');
    const res = await editFileTool.execute(
      { path: 'edit.txt', old_string: 'beta', new_string: 'BETA' },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.equal((res.data as any).replacements, 1);
    assert.equal(fs.readFileSync(path.join(workdir, 'edit.txt'), 'utf8'), 'alpha\nBETA\ngamma\n');
  });

  await check('edit_file 未找到匹配返回 ok=false 且不改文件', async () => {
    fs.writeFileSync(path.join(workdir, 'edit2.txt'), 'hello world\n');
    const res = await editFileTool.execute(
      { path: 'edit2.txt', old_string: 'nope', new_string: 'x' },
      ctx,
    );
    assert.equal(res.ok, false);
    assert.equal(fs.readFileSync(path.join(workdir, 'edit2.txt'), 'utf8'), 'hello world\n');
  });

  await check('edit_file 多处匹配且未 replace_all 时拒绝替换', async () => {
    fs.writeFileSync(path.join(workdir, 'edit3.txt'), 'x x x\n');
    const res = await editFileTool.execute(
      { path: 'edit3.txt', old_string: 'x', new_string: 'y' },
      ctx,
    );
    assert.equal(res.ok, false);
    assert.ok(res.output.includes('3'));
    assert.equal(fs.readFileSync(path.join(workdir, 'edit3.txt'), 'utf8'), 'x x x\n');
  });

  await check('edit_file replace_all 替换所有匹配', async () => {
    fs.writeFileSync(path.join(workdir, 'edit4.txt'), 'a a a\n');
    const res = await editFileTool.execute(
      { path: 'edit4.txt', old_string: 'a', new_string: 'b', replace_all: true },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.equal((res.data as any).replacements, 3);
    assert.equal(fs.readFileSync(path.join(workdir, 'edit4.txt'), 'utf8'), 'b b b\n');
  });

  await check('write_file 自动创建父目录', async () => {
    const res = await writeFileTool.execute(
      { path: 'nested/deep/f.txt', content: 'hi' },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(path.join(workdir, 'nested/deep/f.txt'), 'utf8'), 'hi');
  });

  await check('edit_file 仅缩进差异时容错匹配成功并返回 diff 预览', async () => {
    fs.writeFileSync(path.join(workdir, 'fuzzy.txt'), 'function f() {\n    return 1;\n}\n');
    // old_string 多行且缩进与文件不一致，精确匹配失败，应走容错匹配
    const res = await editFileTool.execute(
      {
        path: 'fuzzy.txt',
        old_string: 'function f() {\nreturn 1;\n}',
        new_string: 'function g() {\n    return 2;\n}',
      },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.equal((res.data as any).replacements, 1);
    assert.ok(res.output.includes('容错匹配'));
    assert.ok(res.output.includes('--- 变更预览 ---'));
    assert.ok(res.output.includes('- '));
    assert.ok(res.output.includes('+ '));
    assert.equal(
      fs.readFileSync(path.join(workdir, 'fuzzy.txt'), 'utf8'),
      'function g() {\n    return 2;\n}\n',
    );
  });

  await check('edit_file 失败时返回最接近候选行与行号诊断', async () => {
    fs.writeFileSync(path.join(workdir, 'diag.txt'), 'const apple = 1;\nconst banana = 2;\n');
    const res = await editFileTool.execute(
      { path: 'diag.txt', old_string: 'const aple = 1;', new_string: 'x' },
      ctx,
    );
    assert.equal(res.ok, false);
    assert.ok(res.output.includes('候选'));
    assert.ok(/L\d+:/.test(res.output));
    assert.ok(res.output.includes('apple'));
  });

  await check('edit_file 精确匹配成功也返回 diff 预览', async () => {
    fs.writeFileSync(path.join(workdir, 'prev.txt'), 'alpha\nbeta\ngamma\n');
    const res = await editFileTool.execute(
      { path: 'prev.txt', old_string: 'beta', new_string: 'BETA' },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.ok(res.output.includes('--- 变更预览 ---'));
    assert.ok(res.output.includes('- beta'));
    assert.ok(res.output.includes('+ BETA'));
  });

  await check('write_file 覆盖已有文件时返回 diff 摘要', async () => {
    fs.writeFileSync(path.join(workdir, 'ow.txt'), 'old line\n');
    const res = await writeFileTool.execute(
      { path: 'ow.txt', content: 'new line\n' },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.ok(res.output.includes('已覆盖写入'));
    assert.ok(res.output.includes('--- 变更摘要 ---'));
    assert.ok(res.output.includes('- old line'));
    assert.ok(res.output.includes('+ new line'));
  });

  await check('write_file 新建文件标注为新建且无 diff 摘要', async () => {
    const res = await writeFileTool.execute(
      { path: 'brand-new.txt', content: 'hello' },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.ok(res.output.includes('已新建文件'));
    assert.ok(!res.output.includes('变更摘要'));
  });

  console.log(`\n全部 ${passed} 项通过。文件工具验证完成。`);
}

main();
