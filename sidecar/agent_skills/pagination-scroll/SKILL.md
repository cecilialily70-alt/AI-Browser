---
name: pagination-scroll
title: 滚动分页与懒加载
description: 无限滚动、下一页、Load more、滚入可视区后再交互
triggers: 滚动,scroll,下一页,分页,page,加载更多,load more,无限,lazy
priority: 65
always_on: false
---

# 滚动 / 分页 / 懒加载

## 滚动
- `scroll(down?, pages?, index?)`：pages≥10 视为滚到顶/底
- 目标元素不在视口：`find_text` 或 scroll 后再读 browser_state
- 内部滚动容器可能带 `|SCROLL|` 前缀：对容器 index 滚

## 分页
- 「下一页 / Next / ›」有 index → click；记录页码于 memory
- Load more：点击后 `wait`，确认 `*[index]` 新条目再继续
- 无限滚动：滚到底 → wait → 比较 elementCount；无增长则停止

## 采集
- 多页抓取用 `scrape_page_data(autoScroll=true)` 或写 results.md 累积
- 避免同页无增量空转超过 3 步（转 `stagnation-recovery`）
