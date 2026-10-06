import type { PreflightItem } from "../lib/agentRules";

export function settingsHasAiKey(settings: {
  ai_provider?: string;
  deepseek_api_key?: string;
  zhipu_api_key?: string;
  custom_api_key?: string;
}): boolean {
  const provider = String(settings.ai_provider ?? "");
  if (provider === "zhipu") return Boolean(String(settings.zhipu_api_key ?? "").trim());
  if (provider === "custom") return Boolean(String(settings.custom_api_key ?? "").trim());
  return Boolean(
    String(settings.deepseek_api_key ?? "").trim() ||
      String(settings.zhipu_api_key ?? "").trim() ||
      String(settings.custom_api_key ?? "").trim(),
  );
}

/** 只在真正拦启动 / 需要留意时出一行，正常状态不占位置 */
export function LaunchPreflightList({
  items,
}: {
  items: PreflightItem[];
  compact?: boolean;
}) {
  const visible = items.filter((item) => {
    if (item.level === "ok") return false;
    if (item.id === "goal") return false;
    if (item.id === "mentions") return false;
    return true;
  });
  if (visible.length === 0) return null;
  return (
    <p className="text-[10px] leading-4 text-warning">
      {visible.map((item) => item.detail || item.label).join(" · ")}
    </p>
  );
}
