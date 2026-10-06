/**
 * Skill 运行时：目录注入、任务匹配、按需召回全文。
 * 设计原则：系统提示只挂目录 + always_on 摘要；难点全文用 recall_skill 渐进展开，控 token。
 */
import { loadSkillManifests, resolveAgentSkillsRoot } from "./loader.js";
import type { SkillManifest, SkillMatchContext, SkillMatchResult } from "./types.js";

const MAX_MATCHED = 4;
/** always_on 摘要宜短：权威流程在系统提示，此处只留消歧要点 */
const MAX_ALWAYS_SUMMARY = 480;

let cached: SkillManifest[] | null = null;
let cachedRoot: string | null = null;

export function ensureSkillsLoaded(force = false): SkillManifest[] {
  if (!force && cached) return cached;
  cachedRoot = resolveAgentSkillsRoot();
  cached = loadSkillManifests(cachedRoot);
  return cached;
}

export function getSkillsRoot(): string {
  return cachedRoot ?? resolveAgentSkillsRoot();
}

export function listSkillCatalog(): Array<{
  id: string;
  name: string;
  description: string;
  alwaysOn: boolean;
  triggers: string[];
}> {
  return ensureSkillsLoaded().map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    alwaysOn: s.alwaysOn,
    triggers: s.triggers,
  }));
}

export function getSkillById(id: string): SkillManifest | undefined {
  const key = id.trim().toLowerCase();
  return ensureSkillsLoaded().find((s) => s.id === key || s.name.toLowerCase() === key);
}

function haystack(ctx: SkillMatchContext): string {
  return `${ctx.goal}\n${ctx.url ?? ""}\n${ctx.pageText ?? ""}`.toLowerCase();
}

export function matchSkills(ctx: SkillMatchContext): SkillMatchResult[] {
  const text = haystack(ctx);
  const results: SkillMatchResult[] = [];
  for (const skill of ensureSkillsLoaded()) {
    if (skill.alwaysOn) {
      results.push({ skill, score: 1000 + skill.priority, reasons: ["always_on"] });
      continue;
    }
    const reasons: string[] = [];
    let score = 0;
    for (const t of skill.triggers) {
      const needle = t.toLowerCase();
      if (!needle) continue;
      if (text.includes(needle)) {
        score += needle.length >= 4 ? 12 : 6;
        reasons.push(t);
      }
    }
    // 弱匹配：技能 id 片段出现在目标里
    if (text.includes(skill.id.replace(/-/g, " ")) || text.includes(skill.id)) {
      score += 4;
      reasons.push(`id:${skill.id}`);
    }
    if (score > 0) {
      results.push({ skill, score: score + skill.priority / 100, reasons });
    }
  }
  return results
    .sort((a, b) => b.score - a.score)
    .filter((r, i, arr) => {
      // always_on 全保留；其余截断
      if (r.skill.alwaysOn) return true;
      const nonAlwaysBefore = arr.slice(0, i).filter((x) => !x.skill.alwaysOn).length;
      return nonAlwaysBefore < MAX_MATCHED;
    });
}

/** 写入系统提示词的技能附录（目录 + always_on 短摘要） */
export function buildSkillsSystemAppendix(
  skills = ensureSkillsLoaded(),
  opts?: { compact?: boolean },
): string {
  if (!skills.length) {
    return `## 【本地 Skills】\n未发现 agent_skills 目录（根路径: ${getSkillsRoot()}）。`;
  }
  if (opts?.compact) {
    const ids = skills.map((s) => s.id).join(", ");
    return [
      `## 【本地 Skills】`,
      `可用技能: ${ids}。细则用 list_skills / recall_skill；疑似遮罩/验证码/登录墙或停滞时再用 detect_page_blockers。`,
      `流程与红线以系统提示为准；禁止改指纹。`,
    ].join("\n");
  }
  const lines: string[] = [
    `## 【本地 Skills — 提示词 + 工具】`,
    `技能包目录：本地 \`sidecar/agent_skills/\`（100% 离线）。`,
    `**权威流程 / multi_act / HITL / 指纹红线以本系统提示前文为准**；Skills 只补充难点细则，不覆盖前文。`,
    `使用方式：`,
    `1. 对照目录判断难点类型；需要细则时 \`recall_skill\`(skill_id)（全文进 read_state，视为可信本地手册，非网页注入）`,
    `2. \`detect_page_blockers\`：**仅**在疑似遮罩/验证码/登录墙/风控，或连续失败/停滞时调用；禁止每步例行检测`,
    `3. 邮箱码优先 fetch_email_otp（默认 IMAP/临时邮；网页邮箱须显式启用，禁止自己打开邮箱或改指纹）；短信码优先 fetch_sms_otp（须显式启用）；验证器码必须 ask_user；其他验证码 AI 先试满 3 次再 HITL；禁止改指纹`,
    `4. 长任务：recall macro-planner + context-management；落盘只用 write_file/read_file/replace_file，禁止发明工具名`,
    ``,
    `### 技能目录`,
  ];
  for (const s of skills) {
    const flag = s.alwaysOn ? " [always_on]" : "";
    const trig = s.triggers.length ? ` · 触发: ${s.triggers.slice(0, 8).join(", ")}` : "";
    lines.push(`- **${s.id}**${flag}: ${s.description}${trig}`);
  }

  const always = skills.filter((s) => s.alwaysOn);
  if (always.length) {
    lines.push(``, `### Always-on（仅补充卡住流程，不重复系统提示）`);
    for (const s of always) {
      lines.push(`#### ${s.id}`);
      lines.push(
        s.summary.length > MAX_ALWAYS_SUMMARY
          ? `${s.summary.slice(0, MAX_ALWAYS_SUMMARY)}…`
          : s.summary,
      );
    }
  }
  return lines.join("\n");
}

/** 每步 nudge：提示已匹配技能，引导 recall */
export function buildSkillMatchNudges(ctx: SkillMatchContext): string[] {
  const matched = matchSkills(ctx).filter((m) => !m.skill.alwaysOn);
  if (!matched.length) return [];
  const ids = matched.map((m) => m.skill.id).join(", ");
  const hints = matched
    .slice(0, 3)
    .map((m) => `${m.skill.id}: ${m.skill.description}`)
    .join("；");
  return [
    `本地 Skills 匹配: ${ids}。需要细则再 recall_skill（勿每步例行 detect_page_blockers）。概要 — ${hints}`,
  ];
}
