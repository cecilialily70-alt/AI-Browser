---
name: dropdowns-pickers
title: 下拉与选择器
description: native select、自定义下拉、日期/国家选择；dropdown_options 优先
triggers: 下拉,dropdown,select,日期,date,picker,选项,国家,省市区
priority: 70
always_on: false
---

# 下拉 / 选择器

## Native `<select>`
1. `dropdown_options(index)` → 读 read_state 选项
2. `select_dropdown(index, text)` 用**精确文案**

## 自定义下拉（div 角色 listbox）
1. `click` 打开
2. 观察 `*[index]` 新选项 → `click` 目标项
3. 可 `find_text` / `search_page` 定位长列表

## 日期 / 国家
- 能键盘输入则 `input` 按站点格式
- 日历控件：点月历格子 index；翻月后再选
- 失败 → 视觉救赎或 ask_user 问期望值格式
