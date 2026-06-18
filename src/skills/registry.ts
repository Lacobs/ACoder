import { loadSkills } from './loader.js';
import type { Skill } from './types.js';

export * from './types.js';
export { loadSkills } from './loader.js';

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  /** 仅返回用户可显式调用的技能（userInvocable !== false），用于 /skills 与 /<name>。 */
  listUserInvocable(): Skill[] {
    return [...this.skills.values()].filter((s) => s.userInvocable !== false);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }
}

export function createSkillRegistry(skillsDir: string): SkillRegistry {
  const registry = new SkillRegistry();
  for (const s of loadSkills(skillsDir)) registry.register(s);
  return registry;
}
