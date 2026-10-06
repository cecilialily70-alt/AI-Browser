---
name: point-select-captcha
title: 点选 / 顺序点击验证码
description: Visual Grid 网格化定位 + 防干扰 Prompt；格号→格心→墨迹质心→content-box 视口映射；禁止模型直出像素、禁止ask_user代点
triggers: 请按顺序点击,请依次点击,请点击,依次按照,点击变换,点选验证码,图标匹配,顺序点击
priority: 95
always_on: false
---

# 点选 / 顺序点击

## 何时用

页面出现「请按顺序点击…」「请依次…」「请点击 "…"」等顺序点选题干时：

本轮唯一动作：`{"solve_captcha": {}}`

## 模块结构

| 层 | 文件 | 职责 |
|---|---|---|
| 图像处理 | `grid_overlay.ts` | 离屏 Canvas 叠半透明网格 + 高对比格号；`gridIdToCenter` 反算 |
| API 请求 | `vision.ts` | 防干扰 Prompt；汉字 glyph / 图标 shape 双模式；普查→绑定→核验 |
| 坐标执行 | `coord_map.ts` + `pipeline.ts` | 格心→墨迹精修→`contentBox.left/top` 视口偏移→拟人点击 |

## 工具行为

1. 类型门禁 `point_select_click`
2. **主图/题干物理分离**：只截主画布；题干 DOM/另图读序；位图=CSS 宽高 1:1
3. **Visual Grid**：送视觉前叠默认 10×10（列 A–J，行 0–9）；`cellW=图宽/cols`，`cellH=图高/rows`；调密度改 `GridDensityOptions`
4. **防干扰 Prompt**：忽略贯穿细线、散点噪点、背景花纹；只认最粗实心笔画/几何主体；**禁止像素坐标，只回报格号**
5. **视觉流程**：
   - 汉字：Stage1 普查 → 墨迹过滤 → Stage2 独占绑定
   - 图标：题干内联图标逐枚导出为完整答案小图 → 轮廓 Dice / VLM 模板对照主图格号 → 池前缀防伪 → 顺序核验；本地斑点普查 + 对比度增强送模
6. **本地反算**：格心 → 墨迹质心（拒线噪/插画）；**逐格 VLM 核验**目标是否在格内，失败则池内重绑；空白邻格自愈
7. **换算**：`finalX = contentBox.left + modelPixelX`（live rect；禁乱加 DPR）
8. **调试**：`sidecar/logs/debug_*.png` + 核对日志
9. Agent 满 3 次再 `handover_to_human`；**禁止 `ask_user` 代点**；**禁止主动刷新**

## 禁止

- 模型直出绝对像素 / 同模型打点复核
- 把贯穿干扰线、噪点、卡通人物/头盔当点击目标
- 空白格无状态复读同一 JSON
- 刷新换题 / 同轮夹带 navigate
- 用 GIF / 滑块 / 算式工具死磕本题
- `ask_user` 让人代点坐标
- 瞬间直线点击
