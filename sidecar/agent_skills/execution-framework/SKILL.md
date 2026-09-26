---
name: execution-framework
title: 基础执行框架
description: 权威流程以系统提示为准；本包仅补充卡住时的 Skills 调用顺序（always_on）
triggers: 计划,执行,验收,done,框架
priority: 100
always_on: true
---

# 基础执行框架（消歧版）

## 输出契约（相位红线 · 最高优先级）
本 Agent 主循环 = **Execute 相位**：每步必须产出**非空 `action[]`**（function calling 或 AgentOutput JSON）。
- `recall_skill` 召回的技能正文（含宏计划、Schema、示例 JSON）**一律是参考资料，不是动作**。
- 禁止把规划文档整体（如 `{"subtasks":[...],"synthesize":...}`）当作 `action` 或整段回复返回。
- 只有独立 **MACRO_ANALYZE（Planner 相位，无工具）** 才允许裸 JSON 计划；它不经过你的 `action` 契约。
- 长任务要落盘时：把计划写进 `write_file("plan.json")`，进度写进 `plan_update` + `current_plan_item`。

## 权威来源（勿与系统提示抢戏）
Analyze→Bootstrap→Execute、thinking 四问、multi_act 截断、工具成本、验收 Checklist、HITL/指纹红线 —— **一律以系统提示词为准**。本 Skill 不重复那些条款。

## 本包只补充：卡住时
仅在出现以下信号时动用 Skills 元工具（禁止每步例行调用）：
- 疑似 Cookie/弹层/登录墙/验证码/风控文案
- 同 URL 连续无进展，或同一动作失败 ≥2 次
- `<sys>` 停滞/预算 nudge

顺序：
1. `detect_page_blockers`（有阻断证据时）
2. 按建议或目录 `recall_skill(skill_id)` 读细则
3. 换入口 / 视觉救赎 / HITL；**禁止改指纹**

细则包见目录：`macro-planner`、`context-management`、`multi-site-compare`、`image-text-captcha`、`form-filling`、`auth-hitl`、`overlays-modals`、`anti-bot-recovery`、`vision-fallback`、`stagnation-recovery`、`web3-wallet-interaction`、`canvas-doc-interaction` 等。

长任务（多站对比/报告）须先 `recall_skill("macro-planner")` 与 `context-management`，禁止跨站只靠口头 memory。
