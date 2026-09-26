---
name: stagnation-recovery
title: 停滞与死循环突破
description: 同 URL 无进展、重复失败动作的强制换策略清单
triggers: 重试,失败,卡住,死循环,停滞,重复,无进展
priority: 85
always_on: false
---

# 停滞恢复

## 触发信号
- 同 URL 连续 3+ 步无进展
- 同一 click/input 失败 2–3 次
- elementCount/URL/关键文案无变化
- `<sys>` 停滞 nudge

## 强制换策略（按序试）
1. 已停滞时再 `detect_page_blockers` → 按建议 skill 处理（正常推进中不要例行 detect）
2. `search_page` 换定位文案；看 `*[index]` 新节点
3. 清弹层（overlays-modals）
4. `go_back` / 换入口 / 站内搜索
5. 视觉救赎
6. HITL
7. `done(success=false)` 交付部分结果

## memory
- 写明「已失败方法」，禁止原样再试
- 步数只是保险丝。没到上限就继续推进，不要为了预算提前交卷
