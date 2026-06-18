export interface Skill {
  /** Unique skill identifier. */
  name: string;
  /** Short human-readable description; the model uses this to decide relevance. */
  description: string;
  /** The skill's specialized instructions, disclosed on demand via use_skill. */
  instructions: string;
  /** Optional hint about when this skill applies; injected into the catalog. */
  whenToUse?: string;
  /** Tools this skill recommends; appended as a soft hint to instructions. */
  allowedTools?: string[];
  /** Whether users can invoke it via /<name>; defaults to true. false = model-only. */
  userInvocable?: boolean;
  /** Directory the skill was loaded from (used for ${SKILL_DIR} substitution). */
  baseDir?: string;
  /** Where the skill was loaded from. */
  source: 'file' | 'dir';
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  whenToUse?: string;
  allowedTools?: string[];
  userInvocable?: boolean;
}
