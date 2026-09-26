---
name: web3-wallet-interaction
title: Web3 与浏览器钱包交互
description: 钱包扩展弹窗、签名/授权/切网/Gas 确认的调度 SOP；敏感签名默认 HITL
triggers: 钱包,wallet,metamask,小狐狸,签名,sign,approve,授权,链上,web3,连接钱包,connect wallet,gas
priority: 86
always_on: false
---

# Web3 / 钱包交互（高阶 SOP 骨架）

## 触发条件
- 页面出现「连接钱包 / Connect Wallet / Sign / Approve / 切换网络」或用户目标含链上操作、NFT、DApp

## 原则
- **页面内按钮**走索引 DOM / 视觉救赎；**扩展弹窗**常不在主文档索引树 → 优先 `tabs-windows` 找扩展页，或 `ask_vision_locate` / HITL
- **签名、转账、无限授权（Approve）**：默认 `handover_to_human` 或 `ask_user` 明确确认；禁止静默代签
- 禁止 evaluate 注入私钥或改指纹

## SOP
1. **识别阶段**：`detect_page_blockers`（若有）+ 观察是否已连接（地址缩写）
2. **连接钱包**  
   - 点击站点「Connect」→ 等待扩展 UI  
   - 扩展 UI 不可索引：视觉点选账户 / 或 HITL  
   - 成功标准：站点显示已连接地址（写入 facts：`wallet_connected=true`，**勿存完整助记词/私钥**）
3. **切网**  
   - 站点提示 Wrong network → 走扩展切网或站点「Switch network」  
   - 失败 3 次（交互类）再 HITL
4. **签名 / Approve**  
   - 读并摘要请求意图到 memory（合约名、权限范围若可见）  
   - **必须人工确认**后再在扩展内确认  
   - 拒绝：记录原因，ask_user 是否中止任务
5. **交易发送**  
   - Gas/费用不可见或异常高 → HITL  
   - 广播后：记录 tx 状态入口 URL 到 facts；轮询用 wait + 刷新，设超时
6. **CHECKPOINT**：`context-management` 只存地址缩写、chainId、txHash、授权结果，不存种子

## skills_to_recall 建议
`overlays-modals`、`vision-fallback`、`auth-hitl`（仅当涉及邮箱/短信/验证器码）、`tabs-windows`、`context-management`

## 成功 / 失败
- 成功：站点态与用户目标一致（已连接 / 已签名 / 已铸造等）且关键哈希已落盘
- 失败：扩展无响应、用户拒绝、超时 → done(success=false) 说明进度
