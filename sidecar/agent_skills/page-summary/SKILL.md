---
name: page-summary
title: 当前页总结与分析
description: 总结/分析当前打开的页面与站点（定位、功能与栏目、要点、注意、不确定）的选型与验收
triggers: 总结,分析,概括,介绍,这个网站,这个页面,当前页,是什么网站,做什么的,summarize,analyze,this site,this page
priority: 72
always_on: false
---

# 当前页总结与分析

信息型目标：交付物是**结论**，不是「到达某个页面」。

## 铁律
- 阅读对象是**已经打开的当前页**：**禁止**为「读懂」而 `navigate` / 点链接跳走 —— 换页就把要读的内容丢了。
- 结论必须是自己的话；**禁止**把 `<page_digest>` /「【页面阅读】」/ `page_summary` 的 Markdown 原文整段贴进 `done`。
- 页面上没有的价格、姓名、数据一律不补；找不到就写「页面上未显示」。

## 选型
| 情况 | 做法 |
|------|------|
| `<page_digest>` 已经够回答 | 直接写结论 → `done(success=true)` |
| 要站点结构 / 功能与栏目 / 更完整的要点 | 调**一次** `page_summary`（只读、不滚动、不导航） |
| 用户明确要一份可留档的报告 | `page_summary(save_report=true)` 落盘 Markdown |
| 只是某一句关键词是否出现 | `search_page`（零成本） |
| digest 与 page_summary 都不足，且问题很具体 | 一次 `extract(query)` |

## 输出结构（page_summary 已固定）
站点/页面定位 · 主要功能与栏目 · 页面内容要点 · 值得注意的信息 · 不确定 / 需人工确认。
`done` 的正文按这五点组织即可，字数满足门槛（默认 ≥ 30 字）并保持实质。

## 多页/整站
本技能只覆盖「当前一个页面」。用户明确要求「整个网站 / 所有栏目 / 对比多个站点」时才需要逐页打开：
那是多步采集任务，应交回模型按计划逐个 `navigate` + `page_summary`，并明确告知用户范围与耗时。
