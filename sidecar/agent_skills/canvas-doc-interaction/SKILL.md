---
name: canvas-doc-interaction
title: 画布与在线文档交互
description: Google Docs/飞书/Notion/Figma 等弱索引或画布型页面的阅读与编辑 SOP
triggers: 飞书,docs,document,文档,notion,figma,画布,白板,google docs,在线文档,协作文档
priority: 84
always_on: false
---

# 复杂文档与图表 / 画布（高阶 SOP 骨架）

## 触发条件
- 目标在 **Google Docs、飞书文档、Notion、Office Online、Figma/白板** 等：索引树稀疏、内容在 canvas/编辑器内核中

## 原则
- 索引 DOM 不足时：**视觉 + 键盘**为主（`ask_vision_locate`、`send_keys`、`find_text`），禁止臆造 CSS 主路径
- 大段阅读：优先 `page_digest` / `extract` / `search_page`；仍不足再视觉分段截图
- 编辑类：小步修改 + 立即把「已改内容摘要」写入 `results.md`（context-management）

## SOP

### A. 阅读 / 抽取
1. 等待加载（骨架屏 → wait）
2. `search_page` 关键词；无果则 scroll 分页式阅读（`pagination-scroll`）
3. 需要结构时 `extract(query=用户问题)`；长文分段写入 results.md，带标题锚点
4. 图表/嵌入：视觉描述关键数字 → facts（confidence=medium）

### B. 编辑 / 填写
1. 视觉定位插入点或菜单（「分享/编辑/标题」）
2. `click` / `ask_vision_locate` 聚焦 → `send_keys` 或 `input`（若有可索引输入框）
3. 每完成一个逻辑段：CHECKPOINT 摘要；避免一次粘贴超长导致超时
4. 协作权限/登录墙：`auth-hitl` 分级规则

### C. 评论 / 建议模式
1. 定位评论入口（常为图标 → vision）
2. 写入评论文本；成功以界面气泡/侧栏为证

## skills_to_recall 建议
`vision-fallback`、`pagination-scroll`、`extraction-scrape`、`overlays-modals`、`context-management`、`locale-language`

## 成功标准
- 阅读：用户问题可在 results/facts 溯源回答
- 编辑：界面可见变更证据（非口头声称）

## 失败升级
- 画布完全无文字索引且视觉连续 3 次失败 → HITL 或 done(false) 交付已读部分
