---
name: tabs-windows
title: 多标签管理
description: new_tab、switch、close；研究任务与外链的标签策略
triggers: 标签,tab,新窗口,new_tab,switch,close,外链
priority: 55
always_on: false
---

# 多标签

## 规则
- `navigate(url, new_tab=true)` 开新标签（新页追加在最后）；默认在活动页导航
- `switch(tab_id)` / `close(tab_id)`：tab_id 用 Open Tabs 的**稳定 id**（如 `t2`）或位置别名 `*2`
- 稳定 id 关掉别的标签后不变；位置别名 `*N` 按当前顺序解析（关前面的标签会让它指向别的页）
- 跨标签搬运数据一律用稳定 id
- `read_tab(tab_id, selectors=[…])`：确定性读任意标签的字段原文（零 LLM，不改写）；比 extract 更适合取值
- `fill_from_tab(from_tab, from_selector, index)`：把来源标签的值原样填进**当前**标签的 `index`（要填别的标签先 switch 过去）；值不经过模型转述
- 不能关闭最后一个标签
- switch/close/navigate 会 terminates_sequence

## 策略
- 研究/比价：详情页 new_tab，保留 SERP
- 外链广告谨慎；优先同站
- 任务结束前可 close 无关标签，但非必须
