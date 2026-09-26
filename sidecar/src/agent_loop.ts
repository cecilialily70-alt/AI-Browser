/**
 * 自主 Agent 入口（兼容层）
 * 实现已迁移至 bu_agent/（browser-use 契约）。
 * 保留 IPC/HITL 类型与历史折叠工具供 diagnostics 使用。
 */
import type { Page } from "playwright-core";

import {
  runBuAutonomousAgentLoop,
  type AgentConfirmActionPreview,
  type AgentConfirmRequest,
  type AgentConfirmResponse,
  type AgentHandoverRequest,
  type AgentLoopDeps,
  type AgentLoopResult,
} from "./bu_agent/service.js";

export type {
  AgentConfirmActionPreview,
  AgentConfirmRequest,
  AgentConfirmResponse,
  AgentHandoverRequest,
  AgentLoopDeps,
  AgentLoopResult,
};
export async function runAutonomousAgentLoop(
  page: Page,
  deps: AgentLoopDeps,
): Promise<AgentLoopResult> {
  return runBuAutonomousAgentLoop(page, deps);
}
