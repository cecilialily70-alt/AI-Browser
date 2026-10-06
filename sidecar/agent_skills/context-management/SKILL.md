---
name: context-management
title: 会话与记忆管理
description: 跨页长链路的工作记忆规范：何时读写 results.md / facts.jsonl / plan.json
triggers: 记忆,memory,results.md,落盘,跨页,长任务,忘记,汇总,checkpoint,工作区
priority: 92
always_on: false
---

# Context & Memory Management（规范骨架 · 无底层 API）

> 指导模型 **何时读/写记忆**。禁止用「模型隐式记忆」跨站点传价格/参数等事实。  
> **所有落盘必须映射到系统提示已登记工具**（见下表）；禁止发明 `save_memory` 等未登记名。  
> **相位约束**：本包全程在 **Execute 相位**使用——每次落盘都必须是 `action[]` 里的 `write_file` / `replace_file` / `read_file`。`plan.json` 的计划正文只能作为 `write_file` 的 `content` 参数，**不得**当作整段回复或 `action` 本身返回（见 `macro-planner` §0/§5）。

## 工具映射（与系统提示 §6 文件 对齐）

| 意图 | 调用（action 键） | 参数要点 |
|------|-------------------|----------|
| 新建/覆盖全文 | `write_file` | `file_name`, `content`；`append=false` 或省略 |
| 追加一行/一段 | `write_file` | `file_name`, `content`, **`append=true`**（facts.jsonl 必须 append） |
| 勾选 todo / 改片段 | `replace_file` | `file_name`, `old_str`, `new_str` |
| 读回事实或报告 | `read_file` | `file_name` → 内容进本轮后 `read_state` |
| 读技能纪律 | `recall_skill` | `skill_id="context-management"` |

约定文件名（工作区相对名）：`todo.md` / `facts.jsonl` / `results.md` / `plan.json`。

| 层 | 文件 | 内容 | 生命周期 |
|----|------|------|----------|
| L0 热上下文 | 每步 XML：history / memory / read_state | 短、易丢 | 单步～数步 |
| L1 工作记忆 | `todo.md` | 子任务勾选 | 整单 |
| L2 事实库 | `facts.jsonl` | 一行一条可溯源事实 | 整单 |
| L3 人读草稿 | `results.md` | 分站点章节 + 最终报告 | 整单 |
| L4 计划快照 | `plan.json` | MacroPlan 或当前 plan | 整单；REPLAN 时更新 |

## 事实条目 Schema（facts.jsonl 每行）

```json
{
  "ts": "ISO-8601",
  "artifact_key": "jd_iphone15",
  "source_url": "https://...",
  "fields": { "title": "", "price": "", "currency": "", "rating": "", "notes": "" },
  "evidence": "browser_state 摘要或工具返回截断",
  "subtask_id": "st_2",
  "confidence": "high | medium | low"
}
```

## 状态机中的读写时机（映射到工具）

```
子任务开始 → read_file("todo.md")；若 depends_on：read_file("facts.jsonl") 或 results 相关节
采集到关键字段 → write_file("facts.jsonl", content=<一行 JSON+\n>, append=true)
离开页面前 → write_file("results.md", …) 或 replace_file 更新站点节
子任务完成 → replace_file("todo.md", 把 "- [ ] st_x" 换成 "- [x] st_x")；memory 只记 artifact_key
重规划时 → read_file("facts.jsonl")；禁止重爬已有 high 置信事实。步数不是提前收尾的理由
SYNTHESIZE → read_file facts + results → write_file/replace_file 写「最终报告」→ 单独一步 done
```

## SOP

### 何时必须 WRITE
1. 价格、型号、评分、库存、卖家、关键 URL 一旦确认
2. 用户约束（预算、颜色、尺码）从对话澄清后
3. HITL 返回的短信/邮箱/验证器码 **用完即忘**：只写「已提交验证」，**禁止**把动态码写入 results.md

### 何时必须 READ
1. 新开标签 / 换域名之后的第一步
2. 开始对比/写报告之前
3. 停滞恢复前（避免重复采集）

### 何时禁止
- 用预训练知识补全未在 facts 出现的价格
- 在 memory 里堆长表格（长内容进 results.md / facts.jsonl）
- 覆盖写入 facts.jsonl（只追加；更正用新行 + `"supersedes": "旧摘要"`）

## results.md 建议骨架

```markdown
# 任务：{mission}

## 进度
- [ ] st_1 …
- [x] st_2 …

## 站点笔记
### {artifact_key}
- URL:
- 字段:
- 备注:

## 最终报告
（SYNTHESIZE 阶段填写）
```

## 与其它 SKILL 的关系
- `macro-planner` 定义 artifact_key / success_criteria
- `multi-site-compare` 只消费 facts，不发明数据
- `extraction-scrape` 负责页内抽取；本包负责 **持久化纪律**
