---
name: extraction-scrape
title: 信息提取与爬取
description: page_digest / search_page / extract / scrape_page_data 选型与验收
triggers: 提取,抓取,爬取,extract,scrape,总结,是谁,介绍,列表,数据
priority: 75
always_on: false
---

# 提取与爬取

## 选型
| 需求 | 工具 |
|------|------|
| 页内关键词是否存在 | `search_page` |
| CSS **探查**结构（非点击主路径） | `find_elements` |
| 已有 page_digest 能回答 | **直接作答 + done** |
| 自然语言复杂抽取 | `extract(query)`（同页同查询一次） |
| 结构化列表/混合爬虫 | `scrape_page_data` |

## 规则
- read_state 仅下一轮可见：重要内容写入 memory 或 `write_file`
- 严禁用预训练知识补网页上不存在的价格/姓名
- 找不到就写「未找到」，勿编造

## 搜索理解类目标
- goal 含 总结/分析/是谁/告诉我 → 优先 digest → done
- digest 不足 → 一次 extract → done
