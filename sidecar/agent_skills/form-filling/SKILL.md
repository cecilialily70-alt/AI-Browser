---
name: form-filling
title: 智能填表
description: 多步表单、校验与建议列表；交互只用 index，CSS 仅可用于 find_elements 探查
triggers: 填表,表单,注册,register,sign up,input,填写,提交,字段,password,邮箱
priority: 80
always_on: false
---

# 智能填表

## 原则
- **交互（click/input）只用当前 browser_state 的 [index]**
- **`find_elements(selector)` 仅作零成本结构探查**，禁止把 CSS 当点击/填写主路径，禁止维护站点硬编码选择器字典
- 标签语义来自 index 旁文本 / aria / placeholder；不确定用 `search_page` 定位文案再找邻近 index
- 资料语种（用英语填姓名）≠ 网站 UI 语言；见 `locale-language`

## 推荐流程
1. 若可见 Cookie/登录墙/遮罩，或上步已失败：再 `detect_page_blockers`；否则直接扫表单（勿每步 detect）
2. 按可见 label 映射本次现生成的资料（与 GeoIP 同城）；不要读取环境里保存的人设
3. 同轮 multi_act：多个 `input` → 最后 `click` 提交（高风险提交可能弹确认）
4. 输入后出现 `*[index]` 建议列表：**点选建议**，勿盲目 Enter（除非确认无下拉）
5. 提交后看校验红字 / toast：用 `search_page` 找错误文案，修正对应字段

## 难点
| 现象 | 处置 |
|------|------|
| 分步向导 | 每步验收后再点 Next；memory 记录已填项 |
| 必填未亮 | scroll 找隐藏字段；自定义下拉走 `dropdowns-pickers` |
| 短信/邮箱/验证器动态码 | 完整注册闭环召回 `account-lifecycle`；邮箱优先 `fetch_email_otp`（IMAP/临时邮，网页邮箱须显式启用且非默认），短信优先 `fetch_sms_otp`（须显式启用），TOTP **必须** `ask_user`；禁止猜码、禁止改指纹（见 `auth-hitl`） |
| 购物结账收货字段 | 购物流召回 `commerce-checkout`；卡号/CVV/支付密码**禁止**当普通人设自动填，走支付 HITL |
| 订票乘客/旅客字段 | 订票流召回 `travel-booking`；资料按本次 Geo 现生成，证件号 `ask_user`；卡号/CVV 走支付 HITL |
| 其他验证码墙 | 见 `auth-hitl` A：视觉 → 工具；满 3 次再 HITL |
| 上传控件 | `upload_file`；路径须真实存在 |
| 无 index 的富文本 | `ask_vision_locate` 或 `evaluate`（禁指纹 API） |

## 禁止
- 用硬编码 CSS/xpath 字典驱动填表主路径
- 未看到成功证据就 done(success=true)
