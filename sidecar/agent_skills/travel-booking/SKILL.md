---
name: travel-booking
title: 旅行订票（停在支付前）
description: 泛用订票/预订阶段图：搜索→选报价→乘客表单→确认页→stop_before_pay；乘客按本次 Geo 现生成，证件号 ask_user；禁止无人支付、禁止读取环境人设、禁止站点硬编码
triggers: 订票,预订,预约,机票,航班,酒店,旅客,乘客,火车票,高铁,车次,行程,booking,book flight,hotel,travel,passenger,traveler,itinerary,train ticket
priority: 86
always_on: false
---

# 旅行订票（停在支付前）

> **本包是策略手册**，不实现浏览器 API。Execute 相位须输出 `action[]`。  
> **禁止**写死某航司/OTA URL / CSS / 文案；差异靠本次 Geo 现生成、lexicon 与页面 index。  
> **支付红线**：无自动支付 / 自动扣款 / 自动提交支付；合法终态是 `stop_before_pay` → `awaiting_human_payment`。

## 0. 阶段图（配置契约 · 非站点脚本）

按序推进；可用 memory 记 `tb_stage=<id>`。跳阶段仅当页面证据已越过该态。

| 序 | stage id | 目标 | 主要动作 | 完成判据（须可观测） |
|----|----------|------|----------|----------------------|
| 1 | `search` | 到达可检索的航班/酒店/车次列表 | `navigate`/`search`；站内搜框填出发地/目的地/日期；细则 `navigation-search` | 报价列表可见，与 goal 中行程相关 |
| 2 | `select_offer` | 选定符合目标的报价/班次/房型 | `click` 列表项 / 筛选 / 「选择」类控件 index | 已进入乘客/旅客信息或下一步确认入口 |
| 3 | `passenger_form` | 填乘客/联系人等非支付字段 | `input`/`click`；按本次 Geo 现生成；证件号 `ask_user`；细则 `form-filling` | 关键乘客字段已填且可通过校验（非卡号/CVV） |
| 4 | `confirm_page` | 核对行程摘要（班次/日期/旅客/金额） | 滚动核对；缺项回上一阶段修正 | 订单确认/支付页可见，摘要与 goal 一致 |
| 5 | `stop_before_pay` | **停在支付前**，交人工完成支付 | `ask_user` / `handover_to_human` / 系统 confirm「请人工完成支付」 | memory：`tb_stage=stop_before_pay`、`terminal=awaiting_human_payment`；**未**自动点支付 |

```
search → select_offer → passenger_form → confirm_page → stop_before_pay
```

## 1. 何时召回

- 用户目标含订票 / 预订 / 机票 / 酒店 / 火车票 / booking / passenger / travel
- Macro 子任务 `skills_to_recall` 含本 id
- `detect_page_blockers` 报订票/旅客相关，或 `payment` 且当前任务是订票流（非商品加购）

商品购物流优先 `commerce-checkout`；本包专注**行程预订**。登录墙 / 验证码仍走 `auth-hitl`。

## 2. 阶段细则

### 2.1 search
1. Cookie/隐私横幅先 `overlays-modals`。
2. 有明确预订站入口 → `navigate`；否则 `search` 或站内搜（勿擅自改写 goal 中的城市/日期/班次约束）。
3. 已在报价列表页 → 跳到 `select_offer`。

### 2.2 select_offer
1. 只用当前 `[index]` 点筛选 / 报价卡片 / 「选择」；禁止站点选择器字典。
2. 多舱等/房型/车次：按 goal 选择；不确定 → `ask_user`。
3. 列表无匹配：放宽筛选或换条件；连续失败记 ledger，勿盲点随机报价冒充完成。

### 2.3 passenger_form（本次现生成）
1. 乘客姓名、生日、性别、电话、邮箱、地址按本次 Geo 现生成，同一任务内保持一致。不要读取环境里保存的人设。
2. 证件号 / 护照号、多人出行、或字段与 goal 冲突 → **`ask_user`**；禁止编造证件号 / 护照号。
3. 系统若警告地址或电话与代理 GeoIP 冲突，以警告为准，勿擅自改成异地资料。
4. **禁止**把卡号 / CVV / 支付密码当普通人设字段自动填（见 §3）。
5. 登录墙：召回 `auth-hitl` / 必要时 `account-lifecycle`；OTP 走 P1 三层。

### 2.4 confirm_page
1. 核对：行程/班次或房型、日期、旅客姓名、应付金额是否出现在页面。
2. 发现错误 → 回 `passenger_form` / `select_offer` 修正，禁止带着明显错误进入支付。

### 2.5 stop_before_pay（铁律终态）
1. 已到订单确认 / 收银台 / 支付页，且非支付关键字段已就绪。
2. **然后必须**其一：`ask_user`（请人工完成支付）、`handover_to_human`、或等待系统对支付 critical 的 confirm。
3. memory 记 `tb_stage=stop_before_pay`、`terminal=awaiting_human_payment`、当前 URL（**勿**存卡号/CVV/OTP/证件号明文）。
4. **禁止**在无人确认下点击「确认支付 / 立即付款 / Pay now」等并宣称已付款。

## 3. 支付红线与 `done` 契约

对齐 `auth-hitl` 与 `hitl_policy`：

| 情况 | 允许 `done(success=true)`？ |
|------|------------------------------|
| 目标明确只要搜到报价 / 填到确认页/收银台，且有停在支付前的页面证据；结论写明 `awaiting_human_payment` / 待人工支付 | ✅ |
| 目标含「帮我付掉 / 支付成功 / 付款完成」等，但无人确认支付（无人工侧证据） | ❌ **禁止** `done(success=true)` 冒充已付款 |
| 人工已确认并完成支付（有 HITL / 接管侧证据） | ✅（仅此可宣称已付款） |
| 自动提交支付 / 自动扣款 / 跳过 HITL 填 CVV | ❌ **永不** |

- 支付 / 卡号 / CVV / 支付密码：永远 Layer 3；风险词走 `action_risk_lexicon.json`（引擎已强制 confirm）。
- 用户取消支付确认 = `denied-by-user`；**禁止**换说法重试同一支付动作 → handover 或结束为 `awaiting_human_payment`。

## 4. 与其它 Skill

| 场景 | 召回 |
|------|------|
| 站内外搜索 | `navigation-search` |
| 乘客/联系填表 | `form-filling`（本包管阶段；填表细则复用） |
| 登录 / OTP / 支付 HITL | `auth-hitl` |
| 弹层 Cookie | `overlays-modals` |
| 长任务拆解 | `macro-planner`（子任务 skills 列入本 id） |
| 商品加购结账 | `commerce-checkout`（非本包） |

## 5. 禁止

- 站点硬编码 URL / 选择器 / 错误文案字典驱动主路径
- 无人支付、自动提交支付、critical 自动填
- 编造乘客证件号 / 护照号；无证据 `done(success=true)`；用「已下单」冒充「已付款」
- 改 navigator/WebGL 等指纹绕过
