---
name: overlays-modals
title: 弹层遮罩与对话框
description: Cookie 横幅、订阅弹窗、模态框、复发遮罩；先清障再主任务
triggers: cookie,弹窗,弹层,遮罩,modal,dialog,同意,订阅,gdpr,关闭
priority: 85
always_on: false
---

# 弹层 / Cookie / 对话框

## 优先级
**先清遮罩，再主任务。** 仅当 browser_state 已见同意/关闭类控件却点不掉、或疑似大面积遮罩时，再 `detect_page_blockers` 确认类型；勿每步例行调用。

## 处置顺序
1. 找「同意 / Accept / 关闭 / X / No thanks」等 index → `click`
2. 无明确按钮：`send_keys("Escape")`
3. 仍在：`scroll` 轻微滚动或点遮罩外（若有 index）
4. 短窗内同一结构反复出现：**勿死磕** → wait / 换入口 / handover

## 原生 dialog
- JS alert/confirm：优先键盘或站点按钮；不要假设已自动接受

## 视觉
- 遮罩挡住主按钮且无文字 index：`screenshot` + `ask_vision_locate`
