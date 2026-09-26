---
name: auth-hitl
title: 登录认证与验证码
description: 邮箱码可走通道；短信码可走显式启用的接码平台；验证器仍必须人工；其他验证码 AI 先试满 3 次再 HITL
triggers: 登录,login,sign in,验证码,captcha,otp,2fa,密码,支付,payment,handover,接管,滑块,turnstile,短信,邮箱,authenticator
priority: 90
always_on: false
---

# 登录 / 验证码 / HITL

## 铁律（验证码分层）

### B1. 邮箱验证码（Layer 2 通道优先）
1. 可先 `click`「发送验证码 / 获取验证码 / 发送邮件」
2. **优先** `fetch_email_otp`（已配置 IMAP / 临时邮时自动取码并填入。网页邮箱**不是默认路径**，只有设置里显式启用适配器才走它）
3. 通道未配置 / 未显式启用 / 超时 / 未登录 / 失败 → **Layer 3**：`ask_user` 或 `handover_to_human`
4. **禁止** AI 猜测/编造；**禁止**自己打开网页邮箱登录；**禁止**为登录改指纹；**禁止**把码写入文件 / memory / results.md

### B2. 短信验证码（Layer 2 可选 · 默认关）
1. 可先 `click`「发送验证码 / 获取验证码」
2. **若设置中已显式启用**短信接码平台 → 优先 `fetch_sms_otp`
3. 未启用 / 超时 / 失败 → **Layer 3**：`ask_user` 或 `handover_to_human`
4. **禁止** AI 猜测/编造；**禁止** `fetch_email_otp`；**禁止**把码写入文件 / memory / results.md

### B3. 必须 100% 人工（验证器）
**仅限**：验证器（Authenticator / TOTP）动态码。
1. 可先 `click`「发送验证码 / 获取验证码」
2. **必须** `ask_user`（或系统人工确认）拿到码值 —— 禁止 AI 猜测/编造；**禁止** `fetch_email_otp` / `fetch_sms_otp`
3. 再用 `input` 填入对应 index

### A. 其他验证码（默认 AI 过）
适用：图形 CAPTCHA、滑块、点选顺序、拼图、Turnstile、算术图、图片选字等一切**非**短信/邮箱/验证器码。

- **图片字符类（静态图 / GIF 动图 / 迷雾 / 停留最长）**：优先 `solve_captcha`（自动分发到 `image_text_read`，静态图与动图同族，无需自己判断）。细则见 `image-text-captcha`。
- **Token 挑战（Turnstile / reCAPTCHA / hCaptcha）**：`solve_captcha` → `token_challenge_remote`（设置中启用第三方服务商时委托求解）。未配置 / 失败 → **立即或满次 HITL**；**禁止**编造 token / 改指纹。
- 其它未封装类型：
  1. `screenshot` / 视觉分析
  2. `ask_vision_locate` / `click_viewport` / `click` / `wait` / `input`
  3. memory 记 `captcha_attempt=N`；**未满 3 次禁止** `ask_user` / `handover_to_human`
  4. **第 3 次仍失败** → 再 `ask_user` 或 `handover_to_human`
  5. 禁止改指纹；无成功证据禁止 `done(success=true)`

### C. 仍禁止
- 把短信/验证器码当成「可 AI 猜的图」或走 `fetch_email_otp`
- 未启用接码平台时对短信字段调用 `fetch_sms_otp` 却不回落 HITL
- 图形四类 captcha 走 `fetch_email_otp` / `fetch_sms_otp`
- 支付 / critical 字段自动填充
- 把网页邮箱当默认取码；为登录网页邮箱改 navigator / WebGL
- 无证据声称已通过；改 navigator/WebGL 过检测

## 登录流
1. 登录墙可按需 `detect_page_blockers`
2. 账号密码：`input` → `click`
3. 缺账号密码凭证：`ask_user`
4. 遇验证码：邮箱 → **B1**；短信 → **B2**；验证器 → **B3**；图片字符类（静态图/GIF 迷雾/停留最长）→ `image-text-captcha`；其它 → **A**

## 注册闭环
目标为**新账号注册**时：优先 `recall_skill("account-lifecycle")`（阶段图含 OTP 与成功证据）；本包仍管 HITL / 验证码分层与支付红线。

## 购物结账
目标为**购物 / 加购 / 结算到收银台**时：优先 `recall_skill("commerce-checkout")`（阶段图含 `stop_before_pay`）；本包仍管支付 HITL critical 与验证码分层。

## 旅行订票
目标为**订票 / 预订 / 机票酒店等到确认页**时：优先 `recall_skill("travel-booking")`（阶段图含 `stop_before_pay`）；乘客资料按本次 Geo 现生成，证件号 `ask_user`；本包仍管支付 HITL critical 与验证码分层。

## 会话
- 已有 Cookie：先试主任务
- 不要为保登录注入 init script

## 支付红线（无自动支付路径 · Layer 3 永远）

**铁律**：不存在「自动支付 / 自动扣款 / 自动提交支付」路径；支付相关 click/fill 一律 HITL critical，目标文案提及「支付」也不豁免。

### 支付表单
- 卡号 / CVV / 支付密码：确认框或 `ask_user`（与「动态验证码」规则独立）；复杂收银台可 `handover_to_human`
- **支付 critical 永不自动填**（含 `fetch_email_otp` / `fetch_sms_otp` 等通道）
- 用户取消确认 = 该动作失败（`denied-by-user`）；**禁止**换说法重试同一支付动作 → 改 handover，或结束为停在支付前

### Commerce / Booking 终态（P3 Skill 契约）
- 合法终态：`awaiting_human_payment`（已到订单确认/收银台，**待人工支付**）；购物流见 `commerce-checkout`，订票流见 `travel-booking`；阶段 id 均为 `stop_before_pay`
- `done(success=true)` **仅**在以下情况允许：
  1. 用户目标**只要**加购/填到收银台或订票确认页（证据满足停在支付前），结论写明待人工支付；或
  2. 人工已确认并完成支付（有人工侧证据）
- 目标含「帮我付掉 / 支付成功」但无人确认支付前：**禁止** `done(success=true)` 冒充已付款
