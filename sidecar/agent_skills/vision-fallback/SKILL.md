---
name: vision-fallback
title: 视觉坐标救赎
description: DOM index 不足时 ask_vision_locate / click_viewport；禁止用 ask_user 猜图标
triggers: 图标,视觉,vision,坐标,语言球,地球,截图,screenshot,图片按钮
priority: 80
always_on: false
---

# 视觉救赎

## 何时用
- 可交互控件无文字（纯图标、canvas、自定义绘制）
- index 点击无效但截图可见
- 用户要求点「右上角语言球/某图」
- **图形/滑块/点选等验证码**：AI 视觉分析后工具执行；memory 计次，**满 3 次**不过再 HITL（见 `auth-hitl`）

## 流程
1. 确认已配置视觉模型；未配置系统会失败停机（不要改问 ask_user）
2. `ask_vision_locate(query=清晰形态描述, click=true)`
3. 或 `screenshot` → 下一轮对照 → `click_viewport(xPercent,yPercent)`

## query 写法
- 好：`右上角圆形红色 EN 语种按钮`
- 差：`点那个` / `切换语言`

## 禁止
- 用 ask_user 问「点哪个图标」
- 无截图时瞎猜坐标
