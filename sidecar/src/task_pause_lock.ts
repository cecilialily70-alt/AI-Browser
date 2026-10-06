/**
 * Milestone 4：Agent 真·挂起锁（Pause / Resume）
 *
 * Node 单线程不能 thread.sleep。做法：
 * - handover 时 await 一个未决 Promise，把 resolve 存入 __resume_locks[taskId]
 * - 本机 HTTP POST /resume 或 stdin agent_handover_continue 调用 resolve，打破 await
 *
 * HTTP 仅监听 127.0.0.1，且要求 Rust 注入的会话共享令牌（`TIANSHUTAI_IPC_TOKEN`）：
 * 防止本机任意进程静默唤醒全部挂起任务。
 */
import { createServer, type Server } from "node:http";

import { readBearerToken, resolveIpcAuthToken, tokenEquals } from "./ipc_auth.js";

type ResumeResolve = () => void;

declare global {
  // eslint-disable-next-line no-var
  var __resume_locks: Record<string, ResumeResolve> | undefined;
}

function locks(): Record<string, ResumeResolve> {
  if (!globalThis.__resume_locks) {
    globalThis.__resume_locks = {};
  }
  return globalThis.__resume_locks;
}

let pauseServer: Server | null = null;
let pauseServerPort: number | null = null;
/** 挂起：返回 Promise，直到 resume(taskId) 被调用 */
export function awaitPause(taskId: string): Promise<void> {
  const id = String(taskId ?? "").trim();
  if (!id) {
    return Promise.resolve();
  }
  // 若已有同 id 锁，先释放旧的，避免泄漏
  const existing = locks()[id];
  if (existing) {
    try {
      existing();
    } catch {
      // ignore
    }
    delete locks()[id];
  }
  return new Promise<void>((resolve) => {
    locks()[id] = () => {
      delete locks()[id];
      resolve();
    };
  });
}

/** 恢复：找到对应 resolve 并调用；返回是否命中 */
export function resumePause(taskId?: string | null): boolean {
  const id = String(taskId ?? "").trim();
  const map = locks();
  if (id) {
    const resolve = map[id];
    if (!resolve) {
      return false;
    }
    resolve();
    return true;
  }
  // 无 requestId：恢复全部挂起（兼容旧「继续」按钮）
  const ids = Object.keys(map);
  if (ids.length === 0) {
    return false;
  }
  for (const key of ids) {
    map[key]?.();
  }
  return true;
}

export function listPausedTaskIds(): string[] {
  return Object.keys(locks());
}
/**
 * 启动本机 Resume HTTP 服务（127.0.0.1 随机端口）。
 * POST /resume  body: {"requestId":"..."} 或 {"all":true}（恢复全部）
 * GET  /health  存活探针（无鉴权，不泄漏任务信息）
 * GET  /paused  需鉴权的挂起任务列表
 */
export function startPauseHttpServer(): Promise<number> {
  if (pauseServer && pauseServerPort) {
    return Promise.resolve(pauseServerPort);
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "/";
      const method = (req.method ?? "GET").toUpperCase();

      const sendJson = (status: number, body: Record<string, unknown>): void => {
        const payload = JSON.stringify(body);
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(payload),
        });
        res.end(payload);
      };

      if (method === "GET" && (url === "/health" || url.startsWith("/health?"))) {
        sendJson(200, { ok: true });
        return;
      }

      const authorized = tokenEquals(resolveIpcAuthToken(), readBearerToken(req.headers["x-auth-token"]));
      if (!authorized) {
        sendJson(401, { ok: false, error: "unauthorized" });
        return;
      }

      if (method === "GET" && (url === "/paused" || url.startsWith("/paused?"))) {
        sendJson(200, { paused: listPausedTaskIds() });
        return;
      }

      if (method === "POST" && (url === "/resume" || url.startsWith("/resume?"))) {
        let raw = "";
        req.on("data", (chunk: Buffer | string) => {
          raw += typeof chunk === "string" ? chunk : chunk.toString("utf8");
          if (raw.length > 64_000) {
            req.destroy();
          }
        });
        req.on("end", () => {
          let requestId = "";
          let resumeAll = false;
          try {
            if (raw.trim()) {
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              requestId = String(parsed.requestId ?? parsed.request_id ?? "").trim();
              resumeAll = parsed.all === true;
            }
          } catch {
            sendJson(400, { ok: false, error: "invalid json" });
            return;
          }
          // 空 body / 未明确 requestId 或 all=true 时不动作，避免「空请求恢复全部」
          if (!requestId && !resumeAll) {
            sendJson(400, { ok: false, error: "requestId or all=true required" });
            return;
          }
          const ok = resumePause(requestId || null);
          sendJson(ok ? 200 : 404, {
            ok,
            requestId: requestId || null,
            remaining: listPausedTaskIds(),
          });
        });
        return;
      }

      sendJson(404, { ok: false, error: "not found" });
    });

    server.on("error", (error) => {
      reject(error);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("pause server failed to bind"));
        return;
      }
      pauseServer = server;
      pauseServerPort = address.port;
      resolve(address.port);
    });
  });
}

export function stopPauseHttpServer(): void {
  if (pauseServer) {
    try {
      pauseServer.close();
    } catch {
      // ignore
    }
  }
  pauseServer = null;
  pauseServerPort = null;
  // 进程退出时释放所有锁，避免悬挂 Promise
  for (const id of listPausedTaskIds()) {
    resumePause(id);
  }
}
