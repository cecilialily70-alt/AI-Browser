/**
 * LLM 调用瞬时故障重试：指数退避 + 抖动（Exponential Backoff with Jitter）。
 *
 * 背景：`createLlmClient` 显式关闭了 SDK 内置重试（maxRetries: 0），
 * 因此 429（限流）与 5xx（网关抖动）会直接冒泡，导致整轮任务无谓失败。
 * 本模块只对「可恢复」错误做有限次退避重试；确定性错误（400/401/403/404）与
 * 主动 abort/整体超时立即上抛，既保证 7x24 无人值守稳定性，又避免放大无效请求。
 */

/** 可恢复的 HTTP 状态码：限流 + 网关/服务瞬时故障 */
const TRANSIENT_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** 可恢复的网络层错误码（连接/读写抖动、DNS 暂态） */
const TRANSIENT_ERROR_CODE = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** 无 HTTP 状态码时，用 SDK 标准错误类名兜底判定网络抖动 */
const TRANSIENT_ERROR_NAMES = new Set(["APIConnectionError", "APIConnectionTimeoutError"]);

/** 主动中断类错误：不得重试 */
const ABORT_ERROR_NAMES = new Set(["AbortError", "APIUserAbortError", "TimeoutError"]);

export const LLM_RETRY_DEFAULTS = {
  /** 含首次调用在内的总尝试次数 */
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
} as const;

export interface LlmRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

function readStatus(error: unknown): number | null {
  const raw =
    (error as { status?: unknown } | null)?.status ??
    (error as { response?: { status?: unknown } } | null)?.response?.status;
  const status = Number(raw);
  return Number.isFinite(status) ? status : null;
}

function readCode(error: unknown): string {
  const code =
    (error as { code?: unknown } | null)?.code ??
    (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" ? code : "";
}

function readName(error: unknown): string {
  return error && typeof error === "object"
    ? String((error as { name?: unknown }).name ?? "")
    : "";
}

/** 是否为值得退避重试的瞬时故障（限流 / 5xx / 网络抖动） */
export function isTransientLlmError(error: unknown): boolean {
  if (error == null) {
    return false;
  }
  const status = readStatus(error);
  if (status !== null && TRANSIENT_HTTP_STATUS.has(status)) {
    return true;
  }
  const code = readCode(error);
  if (code && TRANSIENT_ERROR_CODE.has(code)) {
    return true;
  }
  return TRANSIENT_ERROR_NAMES.has(readName(error));
}

function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  return ABORT_ERROR_NAMES.has(readName(error));
}

/** 读取服务端 `Retry-After`（秒数或 HTTP 日期），无则返回 null */
function parseRetryAfterMs(error: unknown): number | null {
  const headers = (error as { headers?: unknown } | null)?.headers;
  const raw =
    typeof (headers as { get?: (name: string) => string | null } | null)?.get === "function"
      ? (headers as { get: (name: string) => string | null }).get("retry-after")
      : (headers as Record<string, unknown> | null | undefined)?.["retry-after"];
  if (raw == null) {
    return null;
  }
  const text = String(raw).trim();
  if (!text) {
    return null;
  }
  const seconds = Number(text);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(text);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

/** 指数退避 + 等量抖动：delay ∈ [exp/2, exp)，保证基本间隔又打散重试洪峰 */
function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const half = exp / 2;
  return Math.round(half + Math.random() * half);
}

function createAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const err = new Error("LLM 请求已中止");
  err.name = "AbortError";
  return err;
}

/** 可被 AbortSignal 立即打断的 sleep，避免 abort 后仍空转等待 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError(signal));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 以指数退避 + 抖动重试 `fn`，直到成功、判定为不可恢复、尝试次数耗尽或被 abort。
 * 失败时始终抛出最后一次的真实错误，不吞异常。
 */
export async function withLlmRetry<T>(
  fn: () => Promise<T>,
  options: LlmRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? LLM_RETRY_DEFAULTS.maxAttempts);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? LLM_RETRY_DEFAULTS.baseDelayMs);
  const maxDelayMs = Math.max(0, options.maxDelayMs ?? LLM_RETRY_DEFAULTS.maxDelayMs);
  const signal = options.signal;

  let attempt = 0;
  for (;;) {
    try {
      if (signal?.aborted) {
        throw createAbortError(signal);
      }
      return await fn();
    } catch (error) {
      attempt += 1;
      const canRetry =
        attempt < maxAttempts && !isAbortLike(error, signal) && isTransientLlmError(error);
      if (!canRetry) {
        throw error;
      }
      const retryAfterMs = parseRetryAfterMs(error);
      const delayMs = Math.min(
        maxDelayMs,
        retryAfterMs ?? backoffDelayMs(attempt, baseDelayMs, maxDelayMs),
      );
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
}
