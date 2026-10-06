---
name: account-lifecycle
title: 账号生命周期（注册闭环）
description: 泛用注册阶段图：鉴权墙→填表→OTP 三层策略→成功证据→会话保留；禁止站点硬编码与无人支付
triggers: 注册,注册账号,创建账号,创建账户,开户,新用户,register,sign up,signup,create account,create an account,account lifecycle,账号生命周期
priority: 88
always_on: false
---

# 账号生命周期（注册闭环）

> **本包是策略手册**，不实现浏览器 API。Execute 相位须输出 `action[]`。  
> **禁止**写死某站 URL / CSS / 文案；差异靠人设、lexicon 与页面 index。  
> 支付 / 改密 / 删号等 critical 永远 Layer 3（见 `auth-hitl`），本包不覆盖支付。

## 0. 阶段图（配置契约 · 非站点脚本）

按序推进；可用 memory 记 `alc_stage=<id>`。跳阶段仅当页面证据已越过该态。

| 序 | stage id | 目标 | 主要动作 | 完成判据（须可观测） |
|----|----------|------|----------|----------------------|
| 1 | `detect_auth_wall` | 识别登录/注册墙或已在表单页 | 必要时 `detect_page_blockers`；有「注册/Register/Sign up」index 则 `click` | 注册表单可见，或明确已登录（见 §4） |
| 2 | `fill_register` | 按本次现生成的资料填注册表（不读环境人设） | `input`→提交 `click`；细则 `form-filling` | 提交已点，或进入 OTP/成功页 |
| 3 | `handle_otp` | 按通道处理邮箱 \| 短信 \| TOTP | 见 §3（P1 三层） | OTP 字段已授权填入，或本阶段不适用 |
| 4 | `verify_success` | 用证据证明注册/登录成功 | 观察跳转 / 成功文案；对接 evidence ledger | §4 满足后方可 `done(success=true)` |
| 5 | `persist_session` | 保留会话，不主动登出 | 禁止 logout/清 Cookie；环境 userDataDir 自然持久化 | memory 记 `session_established=true` + 当前 URL |

```
detect_auth_wall → fill_register → handle_otp(email|sms|totp) → verify_success → persist_session
```

## 1. 何时召回

- 用户目标含注册 / 创建账号 / sign up / create account
- `detect_page_blockers` 报 `login_wall` 且任务需要**新账号**（而非仅登录）
- Macro 子任务 `skills_to_recall` 含本 id

登录-only（已有账号）优先 `auth-hitl`；本包专注**注册闭环**。

## 2. 阶段细则

### 2.1 detect_auth_wall
1. Cookie/隐私横幅先 `overlays-modals` 关掉。
2. **仅**在疑似墙/验证码/风控，或连续失败时调用 `detect_page_blockers`；禁止每步例行调用。
3. browser_state 已有注册入口 → 直接 `click` 其 index；禁止无谓 `search_page`。
4. 已登录且目标只需「有会话」→ 跳到 `verify_success` / `persist_session`。

### 2.2 fill_register
1. 字段映射：系统提示中的 Geo 上下文与本次现生成资料 / `user_request`；缺关键凭证 → `ask_user`。不要复用浏览器环境里保存的姓名。
2. 交互只用当前 `[index]`；`find_elements` 仅探查，禁止站点选择器字典。
3. 同轮尽量多 `input` 后一次提交；校验红字用 `search_page` 修正。
4. 遇图形验证码：走 `auth-hitl` A / 对应 captcha Skill；满 3 次再 HITL。
5. 电话/地址与代理城市冲突时：以系统警告为准，勿擅自编造异地资料。

### 2.3 handle_otp（P1 三层 · 铁律）

| 类型 | Layer | 动作 |
|------|-------|------|
| 邮箱 OTP | **2** 优先 | 可先点「发送验证码」→ **`fetch_email_otp`**（IMAP / 临时邮；网页邮箱仅设置中显式启用）。未配置 / 未启用 / 超时 / 未登录 / 失败 → Layer 3：`ask_user` / `handover_to_human` |
| 短信 OTP | **2** 可选（默认关） | 可先点发送 → **显式启用接码平台时** `fetch_sms_otp`；未启用/失败 → Layer 3：`ask_user` / handover；**禁止** `fetch_email_otp`、禁止猜码 |
| TOTP / Authenticator | **3** | 同旧短信人工路径；**禁止**通道代填 |
| 支付 / critical 旁路码 | **3** | 永远人工；通道不得代填 |

- **禁止**编造短信/TOTP/邮箱码；**禁止**把码写入 `results.md` / memory 值字段 / 轨迹明文。
- 图形 CAPTCHA ≠ OTP：走 captcha 策略，不走本表。

### 2.4 verify_success
结果型任务。`done(success=true)` 前必须具备以下**至少一类**客观证据（与 completion evidence / `completion_lexicon` 对齐）：
- URL 相对提交前发生跳转（离开注册页），或
- 页面出现 lexicon 强成功态（如「注册成功」「account created」「已登录」等），或
- 弱成功态 **且** 已有可验证副作用（填过表 + 跳转/digest 等 ledger 事实）

失败文案（已被使用、验证失败等）→ 修正或 HITL，**禁止**伪造成功。

### 2.5 persist_session
1. **禁止**点击退出/登出；**禁止** `evaluate` 清 Cookie/storage。
2. CloakBrowser 持久环境（userDataDir）会保留 Cookie；无需自造导出会话工具。
3. memory：`alc_stage=persist_session`、`session_established=true`、成功页 URL（勿存密码/OTP）。

## 3. 与其它 Skill

| 场景 | 召回 |
|------|------|
| 填表交互细节 | `form-filling` |
| 登录墙 / HITL / 支付红线 | `auth-hitl` |
| 弹层 Cookie | `overlays-modals` |
| 风控页 | `anti-bot-recovery` |
| 长任务拆解 | `macro-planner`（子任务 skills 列入本 id） |

## 4. 禁止

- 站点硬编码 URL / 选择器 / 错误文案字典驱动主路径
- 无人支付、自动提交支付、critical 自动填
- 无证据 `done(success=true)`
- 网页邮箱翻信作为默认取码（默认仍是 IMAP / 临时邮；网页邮箱须用户显式启用，失败回落 HITL；禁止为登录改指纹）
- 改 navigator/WebGL 等指纹绕过
