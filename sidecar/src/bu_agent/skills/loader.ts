/**
 * 从 sidecar/agent_skills/<id>/SKILL.md 加载本地技能包。
 * 运行时路径兼容 dist/ 与 cwd。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ENV_AGENT_SKILLS_DIR, readAppEnv } from "../../app_env.js";
import type { SkillManifest } from "./types.js";

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const trimmed = raw.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---")) {
    return { meta: {}, body: trimmed.trim() };
  }
  const end = trimmed.indexOf("\n---", 3);
  if (end < 0) {
    return { meta: {}, body: trimmed.trim() };
  }
  const header = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 4).trim();
  const meta: Record<string, string> = {};
  for (const line of header.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    meta[m[1]!.toLowerCase()] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body };
}

function splitList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(/[,|，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function makeSummary(body: string, max = 420): string {
  const plain = body
    .replace(/^#+\s+/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length <= max ? plain : `${plain.slice(0, max)}…`;
}

export function resolveAgentSkillsRoot(): string {
  const env = readAppEnv(ENV_AGENT_SKILLS_DIR);
  if (env && existsSync(env)) return env;

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../agent_skills"), // dist|src /bu_agent/skills → sidecar/agent_skills
    join(here, "../../../../agent_skills"),
    join(process.cwd(), "agent_skills"),
    join(process.cwd(), "sidecar", "agent_skills"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

export function loadSkillManifests(root = resolveAgentSkillsRoot()): SkillManifest[] {
  if (!existsSync(root)) {
    return [];
  }
  const out: SkillManifest[] = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = join(root, ent.name);
    const skillPath = join(dir, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    try {
      const raw = readFileSync(skillPath, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const id = (meta.name || ent.name).toLowerCase().replace(/\s+/g, "-");
      const alwaysOn =
        /^(1|true|yes|on)$/i.test(meta.always_on || meta.alwayson || "") ||
        id === "execution-framework";
      const priority = Number.parseInt(meta.priority || (alwaysOn ? "100" : "50"), 10);
      out.push({
        id,
        name: meta.title || meta.name || ent.name,
        description: meta.description || `${id} 技能`,
        triggers: splitList(meta.triggers || meta.trigger),
        priority: Number.isFinite(priority) ? priority : alwaysOn ? 100 : 50,
        alwaysOn,
        body,
        summary: makeSummary(body),
        dir,
      });
    } catch {
      // 单个坏包不阻断整库
    }
  }
  return out.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}
