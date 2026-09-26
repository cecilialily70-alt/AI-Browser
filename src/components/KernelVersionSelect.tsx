import {
  FREE_CHROMIUM_VERSION,
  KERNEL_PRESET_OPTIONS,
  isFingerprintOnlyKernelPin,
  presetIdFromBrowserVersion,
} from "../lib/kernelPolicy";
import type { LocalKernel } from "../types";

interface KernelVersionSelectProps {
  value: string;
  onChange: (browserVersion: string) => void;
  disabled?: boolean;
  showFreeKeyHint?: boolean;
  /** 已检测到的本地内核（本地运行目录优先），用于下拉直选 */
  localKernels?: LocalKernel[];
}

function localKernelLabel(kernel: LocalKernel): string {
  const tier = kernel.tier === "pro" ? "Pro" : "免费";
  const source = kernel.source === "bundled" ? "本地" : "缓存";
  return `${tier} ${kernel.version} · ${source}`;
}

/** Shared Chromium pin picker for settings / create / batch create. */
export function KernelVersionSelect({
  value,
  onChange,
  disabled,
  showFreeKeyHint = true,
  localKernels = [],
}: KernelVersionSelectProps) {
  const trimmed = value.trim();
  const localMatch = localKernels.find((k) => k.version === trimmed);
  // 本机已有该内核 → 由「本地内核」组的同名条目选中；否则按「自动 / 自定义」归类。
  // 具体内核不再有独立预设条目：本机有时与「本地内核」组重复，没有时只是未下载的预告。
  const selectValue: string = localMatch ? trimmed : presetIdFromBrowserVersion(trimmed);
  const hint = localMatch
    ? `本地运行目录内核（${localMatch.chromePath}），启动时优先使用，无需下载。`
    : selectValue === "custom"
      ? "自定义完整 Chromium 版本号（4 或 5 段）。下载/启动将严格使用此 pin，不会自动跳到最新。"
      : (KERNEL_PRESET_OPTIONS.find((o) => o.id === selectValue)?.hint ?? "");

  return (
    <div className="space-y-1.5">
      <label className="field-label">
        Chromium 内核
        <select
          className="field-input"
          disabled={disabled}
          value={selectValue}
          onChange={(event) => {
            const id = event.target.value;
            if (id === "custom") {
              onChange(trimmed || FREE_CHROMIUM_VERSION);
              return;
            }
            const presetOption = KERNEL_PRESET_OPTIONS.find((o) => o.id === id);
            if (presetOption) {
              onChange(presetOption.browserVersion);
              return;
            }
            // 本地内核：直接按版本 pin
            onChange(id);
          }}
        >
          {localKernels.length > 0 ? (
            <optgroup label="本地内核（优先使用）">
              {localKernels.map((kernel) => (
                <option key={`${kernel.source}:${kernel.dirName}`} value={kernel.version}>
                  {localKernelLabel(kernel)}
                </option>
              ))}
            </optgroup>
          ) : null}
          {KERNEL_PRESET_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
          <option value="custom">自定义 Pin…</option>
        </select>
      </label>
      {selectValue === "custom" ? (
        <input
          className="field-input font-mono text-caption"
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value.replace(/[^\d.]/g, "").slice(0, 32))}
          placeholder={`例：${FREE_CHROMIUM_VERSION}`}
        />
      ) : null}
      <p className="text-[11px] leading-4 text-muted-foreground">
        {hint}
        {showFreeKeyHint && isFingerprintOnlyKernelPin(value) ? (
          <span className="mt-1 block text-warning">
            免费版：可浏览；AI / Agent / 填表不可用。打开数量不限。
          </span>
        ) : null}
      </p>
    </div>
  );
}
