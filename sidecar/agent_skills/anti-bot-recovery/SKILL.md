---
name: anti-bot-recovery
title: 风控与反爬恢复
description: Cloudflare/403/频率限制的恢复路径；禁止 JS 改指纹或 AutomationControlled
triggers: cloudflare,403,风控,blocked,denied,机器人,rate limit,挑战,turnstile
priority: 90
always_on: false
---

# 风控 / 反爬恢复

## 铁律（产品红线）
- **禁止** evaluate 改 navigator / WebGL / Audio / 时区
- **禁止** 添加 AutomationControlled 或 sandbox 类启动参数
- 环境已由 CloakBrowser 底层处理；Agent 只 CDP 操作页面

## 处置
1. 已出现挑战/403/风控文案时，用 `detect_page_blockers` 确认类型（无迹象勿先调用）
2. 若是可视人机验证（滑块/点选/Turnstile 控件）：按 `auth-hitl` **A** 视觉分析后工具执行
3. `wait(3~8)` 后重新观察；挑战自动过后继续
4. 持续 403 / 无交互挑战页：换公开入口、搜索备源，或 `handover_to_human`
5. 仍失败：`done(success=false)` 说明卡在风控，带回已收集部分结果

## 不要做
- 死磕同一 URL 十余次
- 无证据声称「已通过验证码」
- 改指纹 / AutomationControlled 类手段
