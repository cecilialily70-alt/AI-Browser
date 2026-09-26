---
name: locale-language
title: 语种与地区
description: 资料填写语种与网站 UI 语言语义拆分；GeoIP/人设一致
triggers: 语言,中文,english,locale,语系,翻译,hebrew,日本語,法语,人设,时区
priority: 70
always_on: false
---

# 语种 / 地区

## 语义拆分（强制）
| 概念 | 含义 | 动作 |
|------|------|------|
| **资料语种** | 用英语/中文填写姓名地址 | 只改 input 文本 |
| **网站 UI 语言** | 切换站点界面语言 | 仅当用户明确要求时操作语言菜单 |

## UI 切换
- 语言入口常为图标 → `ask_vision_locate`，禁止 ask_user 猜球
- 切换后 wait，确认 UI 文案变化再继续

## 人设 / Geo
- 已注入 GeoIP 时：电话区号、城市、姓名风格与出口地区一致。姓名每次现生成，不读取环境里保存的人设。
- 不要生成与当前环境矛盾的地址
