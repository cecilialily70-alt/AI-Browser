---
name: commerce-checkout
title: 购物结账（停在支付前）
description: 泛用购物流阶段图：搜品→选 SKU→加购→结账表单→核对订单→stop_before_pay；禁止无人支付与站点硬编码
triggers: 购物,加购,加入购物车,下单,结算,结账,买,购买,收银台,商品,sku,cart,checkout,buy,purchase,add to cart,shopping,commerce
priority: 87
always_on: false
---

# 购物结账（停在支付前）

> **本包是策略手册**，不实现浏览器 API。Execute 相位须输出 `action[]`。  
> **禁止**写死某电商 URL / CSS / 文案；差异靠人设、lexicon 与页面 index。  
> **支付红线**：无自动支付 / 自动扣款 / 自动提交支付；合法终态是 `stop_before_pay` → `awaiting_human_payment`。

## 0. 阶段图（配置契约 · 非站点脚本）

按序推进；可用 memory 记 `cc_stage=<id>`。跳阶段仅当页面证据已越过该态。

| 序 | stage id | 目标 | 主要动作 | 完成判据（须可观测） |
|----|----------|------|----------|----------------------|
| 1 | `search` | 到达可检索的商品列表/站内搜 | `navigate`/`search`；站内搜框 `input`→提交；细则 `navigation-search` | 列表或 SERP 可见目标品相关结果 |
| 2 | `filter_select_sku` | 筛选并选定目标 SKU/规格 | `click` 筛选项 / 规格 / 商品卡片 index | 详情或已选规格页；目标属性与 goal 对齐 |
| 3 | `cart` | 加入购物车（或等价「立即购买」进入结账） | `click` 加购；必要时进购物车核对 | 购物车有目标商品，或已进入结账入口 |
| 4 | `checkout_form` | 填收货/联系等非支付字段 | `input`/`click`；资料来自人设 / `ask_user`；细则 `form-filling` | 关键收货字段已填且可通过校验（非卡号/CVV） |
| 5 | `review_order` | 核对订单摘要（金额/SKU/地址） | 滚动核对；缺项回上一阶段修正 | 订单确认/支付页可见，摘要与 goal 一致 |
| 6 | `stop_before_pay` | **停在支付前**，交人工完成支付 | `ask_user` / `handover_to_human` / 系统 confirm「请人工完成支付」 | memory：`cc_stage=stop_before_pay`、`terminal=awaiting_human_payment`；**未**自动点支付 |

```
search → filter_select_sku → cart → checkout_form → review_order → stop_before_pay
```

## 1. 何时召回

- 用户目标含购物 / 加购 / 下单 / 结算 / buy / cart / checkout / purchase
- Macro 子任务 `skills_to_recall` 含本 id
- `detect_page_blockers` 报 `payment` 且当前任务是购物流（非纯改密/转账）

订票 / 预订优先 `travel-booking`；本包专注**商品购物流**。登录墙 / 验证码仍走 `auth-hitl`。

## 2. 阶段细则

### 2.1 search
1. Cookie/隐私横幅先 `overlays-modals`。
2. 有明确商品站入口 → `navigate`；否则 `search` 或站内搜（勿擅自改写 goal 中的关键实体名）。
3. 已在目标列表页 → 跳到 `filter_select_sku`。

### 2.2 filter_select_sku
1. 只用当前 `[index]` 点筛选 / 规格 / 商品；禁止站点选择器字典。
2. 多规格（颜色/尺码）：按 goal 选择；不确定 → `ask_user`。
3. 列表无目标品：放宽筛选或换词；连续失败记 ledger，勿盲点随机商品冒充完成。

### 2.3 cart
1. 优先「加入购物车」类控件；若仅有「立即购买」且会直达结账，可进入结账但仍须遵守 §3 支付红线。
2. 加购后必要时打开购物车核对 SKU/数量。
3. 目标**只要加购到购物车**且证据满足 → 可 `done(success=true)`，结论写明已加购、**未支付**；勿假装已下单付款。

### 2.4 checkout_form
1. 收货人 / 地址 / 电话 / 邮箱：按本次 Geo 现生成，同一任务内保持一致；冲突以系统警告为准，勿编造异地资料。不要读取环境里保存的人设。
2. 缺关键字段 → `ask_user`；**禁止**把卡号 / CVV / 支付密码当普通人设字段自动填（见 §3）。
3. 登录墙：召回 `auth-hitl` / 必要时 `account-lifecycle`；OTP 走 P1 三层。

### 2.5 review_order
1. 核对：商品名/规格、数量、地址、应付金额是否出现在页面。
2. 发现错误 → 回 `cart` / `checkout_form` 修正，禁止带着明显错误进入支付。

### 2.6 stop_before_pay（铁律终态）
1. 已到订单确认 / 收银台 / 支付页，且非支付关键字段已就绪。
2. **然后必须**其一：`ask_user`（请人工完成支付）、`handover_to_human`、或等待系统对支付 critical 的 confirm。
3. memory 记 `cc_stage=stop_before_pay`、`terminal=awaiting_human_payment`、当前 URL（**勿**存卡号/CVV/OTP）。
4. **禁止**在无人确认下点击「确认支付 / 立即付款 / Pay now」等并宣称已付款。

## 3. 支付红线与 `done` 契约

对齐 `auth-hitl` 与 `hitl_policy`：

| 情况 | 允许 `done(success=true)`？ |
|------|------------------------------|
| 目标明确只要加购 / 填到收银台，且有停在支付前的页面证据；结论写明 `awaiting_human_payment` / 待人工支付 | ✅ |
| 目标含「帮我付掉 / 支付成功 / 付款完成」等，但无人确认支付（无人工侧证据） | ❌ **禁止** `done(success=true)` 冒充已付款 |
| 人工已确认并完成支付（有 HITL / 接管侧证据） | ✅（仅此可宣称已付款） |
| 自动提交支付 / 自动扣款 / 跳过 HITL 填 CVV | ❌ **永不** |

- 支付 / 卡号 / CVV / 支付密码：永远 Layer 3；风险词走 `action_risk_lexicon.json`（引擎已强制 confirm）。
- 用户取消支付确认 = `denied-by-user`；**禁止**换说法重试同一支付动作 → handover 或结束为 `awaiting_human_payment`。

## 4. 与其它 Skill

| 场景 | 召回 |
|------|------|
| 站内外搜索 | `navigation-search` |
| 收货/联系填表 | `form-filling` |
| 登录 / OTP / 支付 HITL | `auth-hitl` |
| 弹层 Cookie | `overlays-modals` |
| 长任务拆解 | `macro-planner`（子任务 skills 列入本 id） |

## 5. 禁止

- 站点硬编码 URL / 选择器 / 错误文案字典驱动主路径
- 无人支付、自动提交支付、critical 自动填
- 无证据 `done(success=true)`；用「已下单」冒充「已付款」
- 改 navigator/WebGL 等指纹绕过
