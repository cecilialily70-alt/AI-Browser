---
name: math-image-captcha
title: 静态算式图验证码
description: 定位算式图→视觉读表达式→白名单求值→填入→点「验证答案」；用完毁图
triggers: 验证答案,计算的结果,提交参赛代码,topic/3,数学验证码,算式,tan,sin,cos,match2025/topic/3
priority: 95
always_on: false
---

# 静态算式图计算

## 何时用

页面出现「请在此处输入计算的结果」+「验证答案」或 match2025/topic/3 时：

本轮唯一动作：`{"solve_captcha": {}}`

（别名 `solve_math_captcha` 同路径；失败后勿换别名顶次数。支持四则、阶乘 `!`、sin/cos/tan。）

## 工具行为

1. 类型门禁 `math_image_solve`
2. 定位静态算式媒体（非 GIF）：按相对表单位置，**不写死图片宽高**
3. 视觉只输出算式**纯文本**；禁止 JSON；禁止模型直接报得数
4. 本地白名单求值（含阶乘 `n!`；不读视觉 JSON 字段）
5. 填入 → 点「验证答案」（排除「提交参赛代码」）
6. 临时图用完即毁；满 3 次失败再 HITL

## 禁止

- 刷新换题 / 同轮夹带 navigate
- 用 GIF 或滑块工具死磕本题
- 从 JSON 字段取 answer/result 填入
- 误点「提交参赛代码」当作验证
