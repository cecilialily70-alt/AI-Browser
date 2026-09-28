/**
 * 描述符注册表（选站 + 优先级 + 加载，三层兜底）
 *
 * 优先级（宪法 §0.4 / §3 硬纪律）：`learned` > `builtin` > **通用模式**。
 *   - `learned` 是 AI 学来的、**全局共享**（站点知识按站点，不按环境/账号；且文件里没有任何用户内容）；
 *   - `builtin` 随仓库发版、**只读**；
 *   - 两者都没有（或都被熔断）时，调用方回落**通用模式**（`config/chat_sites.json` + `site_detect.ts`
 *     的启发式读法）—— 通用模式是**兜底，永不删**，否则「回落」无处可落。
 *
 * 加载纪律（§0.5.3 G/J）：目录缺失 → 如实诊断（不是静默当成「没有站点」）；文件以 `_` 开头跳过
 * （给说明文件留位）；**坏文件只报错不拖垮其它描述符**（一个站的错误不该让别的站也不可用）。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAppEnv } from "../../../app_env.js";
import { descriptorMatchesUrl, parseDescriptor } from "./manifest.js";
import { isConnectorUsable, type ConnectorHealth } from "./health.js";
import type { DescriptorSourceKind, SiteDescriptor } from "./types.js";

export interface LoadedDescriptor {
  descriptor: SiteDescriptor;
  path: string;
  source: DescriptorSourceKind;
}

export interface DescriptorDiagnostic {
  code: string;
  path: string;
  reason: string;
}

export interface LoadResult {
  descriptors: LoadedDescriptor[];
  diagnostics: DescriptorDiagnostic[];
}

export interface DescriptorFileEntry {
  source: DescriptorSourceKind;
  path: string;
  /** 原始 JSON（已 parse）或字符串；字符串会尝试 JSON.parse */
  raw: unknown;
}

/** 纯解析入口：给一批文件内容，产出描述符与诊断（**不做 I/O**，因此可单测） */
export function parseDescriptorEntries(entries: readonly DescriptorFileEntry[]): LoadResult {
  const diagnostics: DescriptorDiagnostic[] = [];
  const byId = new Map<string, LoadedDescriptor>();
  const loaded: LoadedDescriptor[] = [];

  for (const entry of entries) {
    let raw = entry.raw;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch (error) {
        diagnostics.push({
          code: "invalid_json",
          path: entry.path,
          reason: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
    }

    const parsed = parseDescriptor(raw, entry.source);
    if (!parsed.ok || !parsed.descriptor) {
      for (const item of parsed.diagnostics) {
        diagnostics.push({ code: item.code, path: `${entry.path}${item.path}`, reason: item.reason });
      }
      continue;
    }

    const descriptor = parsed.descriptor;
    const existing = byId.get(descriptor.id);
    if (existing) {
      // learned 覆盖 builtin（学习成果优先）；同源重复则报错并保留先出现者
      if (existing.source === "builtin" && descriptor.source === "learned") {
        diagnostics.push({
          code: "learned_overrides_builtin",
          path: entry.path,
          reason: `${descriptor.id}：learned 描述符覆盖同 id 的 builtin（学习成果优先）`,
        });
        const index = loaded.indexOf(existing);
        if (index >= 0) loaded.splice(index, 1);
        byId.set(descriptor.id, { descriptor, path: entry.path, source: entry.source });
        loaded.push({ descriptor, path: entry.path, source: entry.source });
        continue;
      }
      diagnostics.push({
        code: "duplicate_id",
        path: entry.path,
        reason: `${descriptor.id}：已存在同 id 描述符（${existing.path}），本条被忽略`,
      });
      continue;
    }

    const item: LoadedDescriptor = { descriptor, path: entry.path, source: entry.source };
    byId.set(descriptor.id, item);
    loaded.push(item);
  }

  return { descriptors: loaded, diagnostics };
}

function readDirEntries(dir: string, source: DescriptorSourceKind): {
  entries: DescriptorFileEntry[];
  diagnostics: DescriptorDiagnostic[];
} {
  const diagnostics: DescriptorDiagnostic[] = [];
  const entries: DescriptorFileEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    // 目录缺失是**正常**的（例如还没学任何站点）；但必须让调用方能知道，不假装「读到了空目录」
    diagnostics.push({ code: "dir_missing", path: dir, reason: "描述符目录不存在（该来源暂无描述符）" });
    return { entries, diagnostics };
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    if (name.startsWith("_")) continue;
    const path = join(dir, name);
    try {
      entries.push({ source, path, raw: readFileSync(path, "utf8") });
    } catch (error) {
      diagnostics.push({
        code: "read_failed",
        path,
        reason: `读取失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return { entries, diagnostics };
}

export interface DescriptorDirs {
  builtinDirs: readonly string[];
  learnedDirs: readonly string[];
}

/** 从目录加载（builtin 与 learned 分开，升级不覆盖学习成果） */
export function loadDescriptorDirs(dirs: DescriptorDirs): LoadResult {
  const entries: DescriptorFileEntry[] = [];
  const diagnostics: DescriptorDiagnostic[] = [];

  for (const dir of dirs.builtinDirs) {
    const result = readDirEntries(dir, "builtin");
    entries.push(...result.entries);
    diagnostics.push(...result.diagnostics);
  }
  for (const dir of dirs.learnedDirs) {
    const result = readDirEntries(dir, "learned");
    entries.push(...result.entries);
    diagnostics.push(...result.diagnostics);
  }

  const parsed = parseDescriptorEntries(entries);
  return { descriptors: parsed.descriptors, diagnostics: [...diagnostics, ...parsed.diagnostics] };
}

/** builtin 描述符目录候选（随仓库发版；编译产物在 `dist/...`，故向上找 sidecar 根） */
export function builtinConnectorDirs(): string[] {
  const env = readAppEnv("CHAT_CONNECTORS");
  const out: string[] = [];
  if (env) out.push(env);
  const here = dirname(fileURLToPath(import.meta.url));
  // 编译产物在 `sidecar/dist/core/web_chat/descriptor/`，向上四级即 `sidecar/`
  out.push(join(here, "../../../../connectors"));
  out.push(join(process.cwd(), "connectors"));
  out.push(join(process.cwd(), "sidecar", "connectors"));
  return out;
}

/**
 * learned 描述符目录。
 *
 * **必须由调用方显式给出**（Host 知道应用数据目录）；本函数只做「给出的空不空」的检查，
 * **不猜**一个看起来合理的路径 —— 猜错会把学习成果写进错地方，比不写更坏（§0.5.3 J）。
 */
export function resolveLearnedConnectorDir(explicit: string | null | undefined): string | null {
  const direct = String(explicit ?? "").trim();
  if (direct) return join(direct, "connectors", "_learned");
  const env = readAppEnv("CHAT_CONNECTORS_LEARNED");
  if (env && env.trim()) return env.trim();
  return null;
}

export interface PickDescriptorOptions {
  /** 健康状态查询（已停用的描述符不参与选中） */
  healthOf?: (id: string) => ConnectorHealth | null | undefined;
}

/**
 * 按 URL 选描述符。
 *
 * 同源多个命中时取 `version` 高者（再同则路径排序，保证确定性 —— 不能依赖文件系统顺序）。
 */
export function pickDescriptor(
  descriptors: readonly LoadedDescriptor[],
  url: string,
  options: PickDescriptorOptions = {},
): LoadedDescriptor | null {
  const matched = descriptors.filter((item) => descriptorMatchesUrl(item.descriptor, url));
  const usable = matched.filter((item) => isConnectorUsable(options.healthOf?.(item.descriptor.id)));
  if (usable.length === 0) return null;

  const rank = (item: LoadedDescriptor): number => (item.source === "learned" ? 1 : 0);
  usable.sort((a, b) => {
    const byKind = rank(b) - rank(a);
    if (byKind !== 0) return byKind;
    const byVersion = b.descriptor.version - a.descriptor.version;
    if (byVersion !== 0) return byVersion;
    return a.path.localeCompare(b.path);
  });
  return usable[0]!;
}

/** 描述符列表（视图用：来源、版本、健康度、最近失败原因都要能摆出来） */
export interface DescriptorListItem {
  id: string;
  source: DescriptorSourceKind;
  version: number;
  hostPattern: string;
  path: string;
  health: ConnectorHealth | null;
  /** 该描述符有什么能力（视图如实标注「降级」时需要） */
  capabilities: { send: boolean; history: boolean; subscribe: boolean; presence: boolean; threads: boolean; sendImage: boolean };
}

export function listDescriptorItems(
  descriptors: readonly LoadedDescriptor[],
  healthOf: (id: string) => ConnectorHealth | null = () => null,
): DescriptorListItem[] {
  return descriptors.map((item) => ({
    id: item.descriptor.id,
    source: item.descriptor.source,
    version: item.descriptor.version,
    hostPattern: item.descriptor.match.hostPattern,
    path: item.path,
    health: healthOf(item.descriptor.id),
    capabilities: {
      send: item.descriptor.composer.selectors.length > 0,
      sendImage: Boolean(item.descriptor.composer.attach?.buttonSelectors.length),
      history: item.descriptor.history.scrollRoot.length > 0 && item.descriptor.history.batchLimit > 0,
      // 页内事件订阅在 P3 接上（`page_agent`）；声明为空即如实标 false
      subscribe: false,
      presence: item.descriptor.presence.typing.length > 0,
      /** 会话列表勾选（`threads` 声明；没写就只能走通用启发式） */
      threads: Boolean(item.descriptor.threads),
    },
  }));
}

/** 描述符目录是否真的存在（打包抽查用，坑族 G/J：漏拷即静默降级） */
export function connectorDirsPresent(dirs: readonly string[]): boolean {
  return dirs.some((dir) => {
    try {
      return existsSync(dir);
    } catch {
      return false;
    }
  });
}
