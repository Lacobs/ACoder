import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSkills, substituteSkillVars } from '../skills/loader.js';
import { SkillRegistry } from '../skills/registry.js';
import type { Skill } from '../skills/types.js';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  \u2713 ${name}`);
}

function tmpSkillsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mca-skills-'));
}

function main(): void {
  console.log('技能系统验证测试：\n');

  const dir = tmpSkillsDir();

  // 单文件技能（向后兼容）
  fs.writeFileSync(
    path.join(dir, 'explain.md'),
    `---\nname: explain\ndescription: 解释代码\n---\n请解释目标代码。`,
  );

  // 目录式技能 + 富 frontmatter
  const sub = path.join(dir, 'git-commit');
  fs.mkdirSync(sub);
  fs.writeFileSync(
    path.join(sub, 'SKILL.md'),
    `---\nname: git-commit\ndescription: 生成提交信息\nwhen_to_use: 需要提交代码时\nallowed_tools: [run_command, read_file]\nuser_invocable: true\n---\n按规范生成提交信息。资源目录：\${SKILL_DIR}`,
  );

  // 仅模型可用技能
  const internal = path.join(dir, 'internal');
  fs.mkdirSync(internal);
  fs.writeFileSync(
    path.join(internal, 'SKILL.md'),
    `---\nname: internal-only\ndescription: 内部技能\nuser_invocable: false\n---\n内部流程。`,
  );

  const skills = loadSkills(dir);

  check('加载单文件技能与目录式技能', () => {
    const names = skills.map((s) => s.name).sort();
    assert.deepEqual(names, ['explain', 'git-commit', 'internal-only']);
  });

  check('正确解析 when_to_use / allowed_tools / user_invocable', () => {
    const gc = skills.find((s) => s.name === 'git-commit') as Skill;
    assert.equal(gc.whenToUse, '需要提交代码时');
    assert.deepEqual(gc.allowedTools, ['run_command', 'read_file']);
    assert.equal(gc.userInvocable, true);
    assert.equal(gc.source, 'dir');
    assert.ok(gc.baseDir && gc.baseDir.endsWith('git-commit'));
  });

  check('${SKILL_DIR} 变量替换为绝对目录', () => {
    const gc = skills.find((s) => s.name === 'git-commit') as Skill;
    const out = substituteSkillVars(gc.instructions, gc.baseDir);
    assert.ok(!out.includes('${SKILL_DIR}'));
    assert.ok(out.includes(sub.replace(/\\/g, '/')));
  });

  check('listUserInvocable 过滤 user_invocable=false 的技能', () => {
    const reg = new SkillRegistry();
    for (const s of skills) reg.register(s);
    const visible = reg.listUserInvocable().map((s) => s.name).sort();
    assert.deepEqual(visible, ['explain', 'git-commit']);
    assert.equal(reg.list().length, 3);
  });

  check('目录技能覆盖同名单文件技能', () => {
    const d2 = tmpSkillsDir();
    fs.writeFileSync(path.join(d2, 'dup.md'), `---\nname: dup\ndescription: 文件版\n---\n文件正文`);
    const sd = path.join(d2, 'dup');
    fs.mkdirSync(sd);
    fs.writeFileSync(path.join(sd, 'SKILL.md'), `---\nname: dup\ndescription: 目录版\n---\n目录正文`);
    const loaded = loadSkills(d2);
    const dup = loaded.find((s) => s.name === 'dup') as Skill;
    assert.equal(loaded.length, 1);
    assert.equal(dup.source, 'dir');
    assert.equal(dup.description, '目录版');
  });

  console.log(`\n全部 ${passed} 项通过。技能系统验证完成。`);
}

main();
