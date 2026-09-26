/**
 * 任务栏角标标签格式化（实际绘制由 Rust win_taskbar 在 browser_launched 后后台执行）。
 */
export function formatTaskbarBadgeLabel(profileId: string): string {
  const trimmed = profileId.trim();
  const digits = trimmed.replace(/\D/g, "");
  const label = digits.length > 0 ? digits : trimmed;
  return label.slice(0, 4);
}
