---
name: multi-site-compare
title: 多站对比与报告合成
description: 跨站点采集同一实体后，按维度对比并生成报告；依赖 context-management 事实库
triggers: 对比,比价,三家,几个平台,横评,生成报告,汇总对比,哪家便宜
priority: 88
always_on: false
---

# 多站对比与报告（高阶 SOP 骨架）

## 触发条件
- 用户要求比较 **≥2** 个站点/平台的同类商品、服务或信息，并给出结论/表格/报告

## 前置（工具联动）
1. `recall_skill("macro-planner")` → Execute 内用 `write_file("plan.json")` + `plan_update`（勿裸 JSON 顶替 action）
2. `recall_skill("context-management")`：落盘只用 `write_file` / `read_file` / `replace_file`
3. 行为层按需：`navigation-search`、`tabs-windows`、`extraction-scrape`、`overlays-modals`

## SOP
1. **规划**：一站一 SubTask；最后 SYNTHESIZE；维度写入 synthesize.dimensions
2. **采集循环**（每站）
   - `navigate` / `search`（建议 `new_tab`）→ 清弹层 → 定位条目
   - `extract` / `scrape_page_data` / 利用 `page_digest` 取统一字段
   - **立即** `write_file("facts.jsonl", append=true)` + 更新 `results.md`
   - `replace_file` 勾选 `todo.md`；memory 只记 artifact_key
   - **勿误用**系统「搜索类直接 done」：比价/报告类目标在首个 SERP **禁止**提前 `done`
3. **对齐实体**：规格不一在 notes 标「疑似同款/不同款」；勿强行合并
4. **合成**（禁止无目的乱逛）
   - `read_file("facts.jsonl")` → markdown 表 + 结论 → 写入 `results.md` 最终报告
   - **单独一步** `done(text=报告摘要或全文)`
5. **缺站**：按 on_fail；报告写「未取到」，禁止编造

## 成功标准
- [ ] 每个目标站有 facts 行或明确失败原因
- [ ] 报告维度覆盖用户约束
- [ ] 关键数字均可在 facts/工具输出溯源

## 失败升级
- 两站以上采集失败 → REPLAN 或 HITL 问是否缩小范围
