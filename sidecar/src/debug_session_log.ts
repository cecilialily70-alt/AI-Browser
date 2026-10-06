/**
 * Debug-session NDJSON writer (session 8cb5bd). File + ingest; never log secrets/PII.
 */
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INGEST =
  "http://127.0.0.1:7508/ingest/d3193891-a790-4b0d-85e9-7998fa3fd935";

/** Prefer workspace root; also try cwd (sidecar spawn cwd varies). */
function logPaths(): string[] {
  const paths: string[] = [];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/ → repo root
    paths.push(join(here, "..", "..", "debug-8cb5bd.log"));
    // src/ during tsx
    paths.push(join(here, "..", "debug-8cb5bd.log"));
  } catch {
    /* ignore */
  }
  paths.push(join(process.cwd(), "debug-8cb5bd.log"));
  paths.push("E:\\AI-Browser-main\\debug-8cb5bd.log");
  return [...new Set(paths)];
}

export function agentDebugLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown> = {},
  runId = "post-fix",
): void {
  const payload = {
    sessionId: "8cb5bd",
    runId,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  const line = `${JSON.stringify(payload)}\n`;
  for (const path of logPaths()) {
    try {
      appendFileSync(path, line, "utf8");
      break;
    } catch {
      /* try next */
    }
  }
  try {
    fetch(INGEST, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "8cb5bd",
      },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}
