/**
 * 本地 IPC 上报客户端（Milestone 1）
 *
 * Rust 侧 `local_ipc` 服务（仅监听 127.0.0.1）暴露 POST /report，用于接收
 * Sidecar 的轨迹 / 同站控件记忆 / 人设等上报，由 Rust 单写队列统一落库。
 *
 * 使用约定：
 * - Rust 拉起 sidecar 时通过环境变量注入 `TIANSHUTAI_IPC_URL`、`TIANSHUTAI_PROFILE_ID`
 *   与 `TIANSHUTAI_IPC_TOKEN`（鉴权令牌）。
 * - 未注入环境变量（例如本地独立调试 sidecar）时 `IpcClient.global` 返回 null，
 *   调用方回退 stdout 旧链路。
 * - `report` 为 fire-and-forget；请求失败（含 401 鉴权失败）会调用 `fallback`（由调用方补 stdout）。
 */
import { request } from "node:http";

import { ENV_IPC_URL, ENV_PROFILE_ID, readAppEnv } from "./app_env.js";
import { resolveIpcAuthToken } from "./ipc_auth.js";

let globalClient: IpcClient | null | undefined = undefined;

export class IpcClient {
  readonly baseUrl: string;
  private readonly profileId: string;
  private readonly authToken: string;
  private readonly timeoutMs: number;

  private constructor(baseUrl: string, profileId: string, authToken: string, timeoutMs = 3000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.profileId = profileId;
    this.authToken = authToken;
    this.timeoutMs = timeoutMs;
  }

  /** 从环境变量构造；未配置时返回 null（调用方回退 stdout）。 */
  static fromEnv(): IpcClient | null {
    const baseUrl = readAppEnv(ENV_IPC_URL);
    if (!baseUrl) {
      return null;
    }
    const profileId = readAppEnv(ENV_PROFILE_ID) ?? "unknown";
    return new IpcClient(baseUrl, profileId, resolveIpcAuthToken());
  }

  /** 懒加载全局实例（任意入口按需初始化，无需显式 init）。 */
  static get global(): IpcClient | null {
    if (globalClient === undefined) {
      globalClient = IpcClient.fromEnv();
    }
    return globalClient;
  }

  /**
   * fire-and-forget 上报；请求失败时回调 `fallback`（避免丢数据）。
   *
   * 注意：HTTP 投递成功但服务端随后崩溃的极端场景可能造成重复写入；
   * 对于轨迹/控件记忆这类持久化数据，宁重复勿丢失，故不在此做去重。
   */
  report(reportType: string, data: Record<string, unknown>, fallback?: () => void): void {
    const body = JSON.stringify({
      type: reportType,
      profileId: this.profileId,
      ...data,
    });

    let settled = false;
    const doFallback = (): void => {
      if (!settled) {
        settled = true;
        fallback?.();
      }
    };

    try {
      const req = request(
        `${this.baseUrl}/report`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            // 鉴权：Rust 侧 local_ipc 对缺失/错误令牌返回 401，此时回退 stdout 链路。
            ...(this.authToken ? { "X-Auth-Token": this.authToken } : {}),
          },
        },
        (res) => {
          // 消费响应体，避免连接泄漏
          res.resume();
          // 4xx/5xx（含 401 鉴权失败）视为投递失败，交给调用方补 stdout，避免数据丢失
          if (res.statusCode && res.statusCode >= 400) {
            doFallback();
            return;
          }
          settled = true;
        },
      );
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error("ipc report timeout"));
      });
      req.on("error", doFallback);
      req.write(body);
      req.end();
    } catch {
      doFallback();
    }
  }
}

/**
 * 优先走本地 IPC /report，失败或未注入 IPC 环境时回退 fallback（由调用方补 stdout）。
 * 语义与「const client = IpcClient.global; if (client) client.report(...) else fallback()」完全一致。
 */
export function reportOrFallback(
  reportType: string,
  data: Record<string, unknown>,
  fallback: () => void,
): void {
  const client = IpcClient.global;
  if (client) {
    client.report(reportType, data, fallback);
  } else {
    fallback();
  }
}
