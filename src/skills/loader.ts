import fs from 'node:fs';
import path from 'node:path';
import type { Skill } from './types.js';

/**
 * 解析极简 YAML frontmatter（仅支持 key: value 与简单数组），
 * 避免引入额外依赖。技能正文为 frontmatter 之后的 Markdown 内容。
 */
function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return { meta: {}, body: raw };

  const metaBlock = fmMatch[1];
  const body = fmMatch[2] ?? '';
  const meta: Record<string, unknown> = {};

  for (const line of metaBlock.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let value = m[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      meta[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body: body.trim() };
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return undefined;
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return undefined;
}

/** 把解析出的 frontmatter + 正文组装为 Skill；缺少必填字段返回 null。 */
function buildSkill(
  meta: Record<string, unknown>,
  body: string,
  source: 'file' | 'dir',
  baseDir: string | undefined,
): Skill | null {
  const name = asString(meta.name);
  const description = asString(meta.description);
  if (!name || !description || !body) return null;

  return {
    name,
    description,
    instructions: body,
    whenToUse: asString(meta.when_to_use) || undefined,
    allowedTools: asStringArray(meta.allowed_tools),
    userInvocable: asBool(meta.user_invocable),
    baseDir,
    source,
  };
}

/** 替换技能指令中的 ${SKILL_DIR} 为该技能所在目录的绝对路径。 */
export function substituteSkillVars(instructions: string, baseDir?: string): string {
  if (!baseDir) return instructions;
  return instructions.replace(/\$\{SKILL_DIR\}/g, baseDir.replace(/\\/g, '/'));
}

/**
 * 加载技能目录，返回合法技能；非法定义会被跳过并打印警告。
 * 同时支持两种来源：
 *   1. 顶层单文件技能：<skillsDir>/<name>.md
 *   2. 目录式技能：    <skillsDir>/<name>/SKILL.md（对齐 Claude Code）
 * 同名冲突时，目录式技能优先（覆盖单文件技能）并告警。
 */
export function loadSkills(skillsDir: string): Skill[] {
  if (!fs.existsSync(skillsDir)) return [];

  const byName = new Map<string, Skill>();

  // 1) 顶层单文件技能
  for (const file of fs.readdirSync(skillsDir).filter((f) => f.endsWith('.md'))) {
    const full = path.join(skillsDir, file);
    if (!fs.statSync(full).isFile()) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch {
      console.warn(`[skills] 无法读取 ${file}，已跳过。`);
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    const skill = buildSkill(meta, body, 'file', undefined);
    if (!skill) {
      console.warn(`[skills] ${file} 缺少必填字段（name/description/正文），已跳过。`);
      continue;
    }
    byName.set(skill.name, skill);
  }

  // 2) 目录式技能 <name>/SKILL.md
  for (const entry of fs.readdirSync(skillsDir)) {
    const dir = path.join(skillsDir, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    const skillFile = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(skillFile, 'utf8');
    } catch {
      console.warn(`[skills] 无法读取 ${entry}/SKILL.md，已跳过。`);
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    const skill = buildSkill(meta, body, 'dir', dir);
    if (!skill) {
      console.warn(`[skills] ${entry}/SKILL.md 缺少必填字段（name/description/正文），已跳过。`);
      continue;
    }
    if (byName.has(skill.name)) {
      console.warn(`[skills] 技能名「${skill.name}」冲突，目录式技能覆盖同名单文件技能。`);
    }
    byName.set(skill.name, skill);
  }

  return [...byName.values()];
}
