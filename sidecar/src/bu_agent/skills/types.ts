/** 本地 Agent Skill 清单类型（提示词 + 可选工具扩展） */

export interface SkillManifest {
  /** 目录名 / frontmatter name，小写连字符 */
  id: string;
  name: string;
  /** 一行说明：写入系统提示词目录 */
  description: string;
  /** 匹配关键词（任务目标 / URL / 页面文本） */
  triggers: string[];
  /** 数字越大越优先；always_on 技能默认最高 */
  priority: number;
  /** 是否始终注入摘要（执行框架类） */
  alwaysOn: boolean;
  /** SKILL.md 正文（不含 frontmatter） */
  body: string;
  /** 正文前 ~N 字的短摘要，用于匹配 nudge */
  summary: string;
  dir: string;
}

export interface SkillMatchContext {
  goal: string;
  url?: string;
  pageText?: string;
}

export interface SkillMatchResult {
  skill: SkillManifest;
  score: number;
  reasons: string[];
}
