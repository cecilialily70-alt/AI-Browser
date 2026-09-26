---
name: navigation-search
title: 导航与搜索
description: Bootstrap URL、SERP、检索词锁定、搜索类任务何时直接 done
triggers: 搜索,search,google,bing,打开,导航,navigate,网址,url,serp
priority: 70
always_on: false
---

# 导航与搜索

## Bootstrap
- 任务含明确 URL → 系统可能已 navigate；勿重复无意义打开
- 无 URL 但有站点名 → `search` 或拼官方 URL 后 `navigate`
- about:blank 上禁止「先全量观察再想办法」空转

## 检索词
- 使用 Analyze 给出的检索词提示，**勿擅自改写**关键实体名
- `search(query, engine?)` 默认 google；engine: bing|duckduckgo

## SERP 策略
- 目标仅「搜索/打开到结果」且 `page_digest` 已显示结果 → **直接 done**
- 目标「找官网/点第一条」→ 点自然结果 index，避免广告
- 目标「总结/是谁/介绍」→ 优先 page_digest 作答；不足再进详情页或 extract

## 失败
- 404/打不开：换镜像、search 官网、或 done(false) 说明
- 地区限制：勿改指纹；可 handover 或换公开源
