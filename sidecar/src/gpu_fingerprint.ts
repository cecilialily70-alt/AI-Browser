import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ENV_GPU_MODE, readAppEnv } from "./app_env.js";

const execFileAsync = promisify(execFile);

export type GpuFingerprintMode = "native_passthrough" | "local_explicit" | "seed_derived" | "pool_random";

export interface LocalGpuInfo {
  vendor: string;
  renderer: string;
  rawName: string;
  adapter: string;
  source: "wmi" | "system_profiler" | "lspci" | "pool";
}

export type ProfileWebglMode = "local" | "random";

export interface GpuLaunchPlan {
  mode: GpuFingerprintMode;
  args: string[];
  localGpu: LocalGpuInfo | null;
}

/** WebGL UNMASKED renderer 是否为本机 ANGLE 完整串（native 透传特征） */
export function isNativeAngleRenderer(renderer: string | null | undefined): boolean {
  const value = renderer?.trim() ?? "";
  return value.includes("ANGLE (") && value.includes("Direct3D11");
}

/** 探测到的本机显卡名是否出现在 WebGL renderer 中 */
export function rendererMatchesLocalGpu(renderer: string | null | undefined, localGpu: LocalGpuInfo | null): boolean | null {
  if (!renderer || !localGpu?.rawName) {
    return null;
  }
  const normalized = localGpu.rawName.replace(/\((R|TM)\)/gi, "").replace(/\s+/g, " ").trim().toLowerCase();
  const probe = renderer.replace(/\((R|TM)\)/gi, "").replace(/\s+/g, " ").trim().toLowerCase();
  return probe.includes(normalized) || normalized.split(" ").filter((part) => part.length > 2).every((part) => probe.includes(part));
}

function normalizeGpuName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** 常见真实桌面显卡池（Windows WebGL UNMASKED 短串，供 CloakBrowser `--fingerprint-gpu-*` 注入） */
export const REAL_GPU_PROFILE_POOL: ReadonlyArray<{
  vendor: string;
  renderer: string;
  brand: "Intel" | "NVIDIA" | "AMD";
}> = [
  { brand: "Intel", vendor: "Google Inc. (Intel)", renderer: "Intel(R) UHD Graphics 630" },
  { brand: "Intel", vendor: "Google Inc. (Intel)", renderer: "Intel(R) UHD Graphics 730" },
  { brand: "Intel", vendor: "Google Inc. (Intel)", renderer: "Intel(R) Iris(R) Xe Graphics" },
  { brand: "Intel", vendor: "Google Inc. (Intel)", renderer: "Intel(R) HD Graphics 530" },
  { brand: "NVIDIA", vendor: "Google Inc. (NVIDIA)", renderer: "NVIDIA GeForce GTX 1050 Ti" },
  { brand: "NVIDIA", vendor: "Google Inc. (NVIDIA)", renderer: "NVIDIA GeForce GTX 1660" },
  { brand: "NVIDIA", vendor: "Google Inc. (NVIDIA)", renderer: "NVIDIA GeForce RTX 3060" },
  { brand: "NVIDIA", vendor: "Google Inc. (NVIDIA)", renderer: "NVIDIA GeForce RTX 4060" },
  { brand: "NVIDIA", vendor: "Google Inc. (NVIDIA)", renderer: "NVIDIA GeForce RTX 4070" },
  { brand: "AMD", vendor: "Google Inc. (AMD)", renderer: "AMD Radeon RX 580 Series" },
  { brand: "AMD", vendor: "Google Inc. (AMD)", renderer: "AMD Radeon RX 6600" },
  { brand: "AMD", vendor: "Google Inc. (AMD)", renderer: "AMD Radeon RX 7900 XT" },
] as const;

function seedToPoolIndex(seed: string, poolSize: number): number {
  if (poolSize <= 0) {
    return 0;
  }
  const trimmed = seed.trim();
  const numeric = Number.parseInt(trimmed, 10);
  if (Number.isFinite(numeric) && numeric >= 10_000 && numeric <= 99_999) {
    return numeric % poolSize;
  }
  let hash = 0;
  for (const char of trimmed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % poolSize;
}

/** 按指纹种子从真实显卡池中稳定选取一项（同环境重启结果一致） */
export function pickGpuFromRealPool(fingerprintSeed: string): (typeof REAL_GPU_PROFILE_POOL)[number] {
  const index = seedToPoolIndex(fingerprintSeed, REAL_GPU_PROFILE_POOL.length);
  return REAL_GPU_PROFILE_POOL[index]!;
}

function poolGpuToLocalInfo(entry: (typeof REAL_GPU_PROFILE_POOL)[number]): LocalGpuInfo {
  return {
    vendor: entry.vendor,
    renderer: entry.renderer,
    rawName: entry.renderer,
    adapter: entry.brand,
    source: "pool",
  };
}

/**
 * 将 Windows WMI 读到的显卡名映射为 CloakBrowser 官方 `--fingerprint-gpu-*` 短串。
 * renderer 只需传型号，二进制会包成 ANGLE 字符串（Issue #294）。
 */
export function mapWindowsGpuToWebgl(name: string, adapter: string): Pick<LocalGpuInfo, "vendor" | "renderer"> {
  const gpuName = normalizeGpuName(name);
  const adapterName = normalizeGpuName(adapter);
  const lower = gpuName.toLowerCase();

  if (adapterName.toLowerCase().includes("nvidia") || lower.includes("nvidia") || lower.includes("geforce")) {
    const model = gpuName.replace(/^nvidia\s+/i, "").trim();
    return {
      vendor: "Google Inc. (NVIDIA)",
      renderer: model.startsWith("NVIDIA") ? model : `NVIDIA ${model}`,
    };
  }

  if (adapterName.toLowerCase().includes("amd") || lower.includes("radeon") || lower.includes("amd")) {
    return {
      vendor: "Google Inc. (AMD)",
      renderer: gpuName,
    };
  }

  return {
    vendor: "Google Inc. (Intel)",
    renderer: gpuName,
  };
}

async function probeWindowsGpu(): Promise<LocalGpuInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_VideoController | Where-Object { $_.Name } | Select-Object Name, AdapterCompatibility, VideoProcessor, Status | ConvertTo-Json -Compress",
      ],
      { timeout: 8_000, windowsHide: true },
    );
    const parsed = JSON.parse(String(stdout).trim()) as
      | { Name?: string; AdapterCompatibility?: string; VideoProcessor?: string; Status?: string }
      | Array<{ Name?: string; AdapterCompatibility?: string; VideoProcessor?: string; Status?: string }>;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const candidates = entries
      .map((entry) => ({
        rawName: normalizeGpuName(String(entry.Name ?? "")),
        adapter: normalizeGpuName(String(entry.AdapterCompatibility ?? "")),
        processor: normalizeGpuName(String(entry.VideoProcessor ?? "")),
        status: String(entry.Status ?? "").toLowerCase(),
      }))
      .filter((entry) => entry.rawName.length > 0)
      .filter((entry) => !/microsoft basic|remote display|virtual/i.test(entry.rawName));

    if (candidates.length === 0) {
      return null;
    }

    const score = (entry: (typeof candidates)[number]): number => {
      const name = `${entry.rawName} ${entry.adapter}`.toLowerCase();
      let value = 0;
      if (entry.status === "ok") value += 4;
      if (/nvidia|geforce|radeon|amd rx|arc a/i.test(name)) value += 10;
      if (/intel|uhd|iris|hd graphics/i.test(name)) value += 6;
      return value;
    };

    const picked = [...candidates].sort((a, b) => score(b) - score(a))[0]!;
    const mapped = mapWindowsGpuToWebgl(picked.rawName, picked.adapter);
    return {
      ...mapped,
      rawName: picked.rawName,
      adapter: picked.adapter || "unknown",
      source: "wmi",
    };
  } catch {
    return null;
  }
}

async function probeMacGpu(): Promise<LocalGpuInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      "system_profiler",
      ["SPDisplaysDataType", "-json"],
      { timeout: 8_000 },
    );
    const parsed = JSON.parse(String(stdout)) as {
      SPDisplaysDataType?: Array<{ sppci_model?: string; _name?: string }>;
    };
    const display = parsed.SPDisplaysDataType?.[0];
    const rawName = normalizeGpuName(String(display?.sppci_model ?? display?._name ?? ""));
    if (!rawName) {
      return null;
    }
    return {
      vendor: "Apple Inc.",
      renderer: rawName,
      rawName,
      adapter: "Apple",
      source: "system_profiler",
    };
  } catch {
    return null;
  }
}

async function probeLinuxGpu(): Promise<LocalGpuInfo | null> {
  try {
    const { stdout } = await execFileAsync("lspci", ["-mm"], { timeout: 8_000 });
    const line = String(stdout)
      .split(/\r?\n/)
      .find((entry) => /VGA compatible controller|3D controller|Display controller/i.test(entry));
    if (!line) {
      return null;
    }
    const parts = line.split('"').map((part) => part.trim()).filter(Boolean);
    const rawName = normalizeGpuName(parts[parts.length - 1] ?? "");
    if (!rawName) {
      return null;
    }
    const mapped = mapWindowsGpuToWebgl(rawName, rawName);
    return {
      ...mapped,
      rawName,
      adapter: parts[parts.length - 2] ?? "unknown",
      source: "lspci",
    };
  } catch {
    return null;
  }
}

/** 读取本机真实显卡信息，供日志与 local_explicit 兜底模式使用。 */
export async function probeLocalGpu(): Promise<LocalGpuInfo | null> {
  if (process.platform === "win32") {
    return probeWindowsGpu();
  }
  if (process.platform === "darwin") {
    return probeMacGpu();
  }
  return probeLinuxGpu();
}

function resolveRequestedGpuMode(): "native" | "local" | "seed" {
  const raw = readAppEnv(ENV_GPU_MODE)?.toLowerCase();
  if (raw === "native" || raw === "passthrough") {
    return "native";
  }
  if (raw === "local" || raw === "explicit") {
    return "local";
  }
  if (raw === "seed") {
    return "seed";
  }
  // Windows 默认 local：官方文档明确 --fingerprint=seed 会派生假 GPU，须用 gpu-vendor/renderer 覆盖本机显卡
  return process.platform === "win32" ? "local" : "native";
}

/**
 * 决定 GPU 启动策略（对照 CloakBrowser 官方 README Additional Flags）：
 * - **Windows + `--fingerprint=seed`**：二进制会从种子自动生成 GPU（如 RTX 3060），146 Free 不会 native 透传
 * - **必须** `--fingerprint-gpu-vendor/renderer` 覆盖为本机 WMI 显卡，才能与 D3D 渲染一致
 * - `--fingerprint=off` 仅 148+ 可用，且会关闭全部 spoofing，不适合多种子多开场景
 * - Free 146 的 BrowserScan WebGL −5% 为官方已知补丁差距，151+ Pro 才完整
 */
export async function buildGpuLaunchPlan(options?: {
  chromiumVersion?: string | null;
  /** 环境级 WebGL 策略：local=本机显卡，random=指纹种子从真实显卡池选取 */
  profileWebglMode?: ProfileWebglMode | null;
  /** 指纹种子，random 模式下用于稳定映射显卡池索引 */
  fingerprintSeed?: string | null;
}): Promise<GpuLaunchPlan> {
  const localGpu = await probeLocalGpu();
  const requested =
    options?.profileWebglMode === "random"
      ? "seed"
      : options?.profileWebglMode === "local"
        ? "local"
        : resolveRequestedGpuMode();

  if (requested === "seed") {
    const picked = pickGpuFromRealPool(options?.fingerprintSeed?.trim() || "10000");
    const poolGpu = poolGpuToLocalInfo(picked);
    return {
      mode: "pool_random",
      localGpu: poolGpu,
      args: [
        `--fingerprint-gpu-vendor=${poolGpu.vendor}`,
        `--fingerprint-gpu-renderer=${poolGpu.renderer}`,
      ],
    };
  }

  if (process.platform === "win32") {
    if (requested === "native") {
      return {
        mode: "native_passthrough",
        localGpu,
        args: [],
      };
    }
    if (localGpu) {
      return {
        mode: "local_explicit",
        localGpu,
        args: [
          `--fingerprint-gpu-vendor=${localGpu.vendor}`,
          `--fingerprint-gpu-renderer=${localGpu.renderer}`,
        ],
      };
    }
    return {
      mode: "native_passthrough",
      localGpu: null,
      args: [],
    };
  }

  if (process.platform === "darwin") {
    if (requested === "local" && localGpu) {
      return {
        mode: "local_explicit",
        localGpu,
        args: [
          `--fingerprint-gpu-vendor=${localGpu.vendor}`,
          `--fingerprint-gpu-renderer=${localGpu.renderer}`,
        ],
      };
    }
    return {
      mode: "native_passthrough",
      localGpu,
      args: [],
    };
  }

  if (requested === "local" && localGpu) {
    return {
      mode: "local_explicit",
      localGpu,
      args: [
        `--fingerprint-gpu-vendor=${localGpu.vendor}`,
        `--fingerprint-gpu-renderer=${localGpu.renderer}`,
      ],
    };
  }

  return {
    mode: "seed_derived",
    localGpu,
    args: [],
  };
}
