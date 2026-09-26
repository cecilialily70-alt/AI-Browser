---
name: downloads-upload
title: 下载上传与 PDF
description: upload_file、save_as_pdf、等待下载落盘；路径与超时处理
triggers: 上传,下载,download,upload,pdf,附件,文件,file
priority: 60
always_on: false
---

# 下载 / 上传 / PDF

## 上传
- `upload_file(index, path)`：path 必须是本机真实路径
- 先定位 `input[type=file]` 对应 index；被自定义按钮包装时可能需点触发后再传

## PDF
- `save_as_pdf(file_name?)` 写入 Agent 工作区
- 浏览器内置 PDF 查看器：可能需先 navigate 到文件 URL

## 下载
- 点击下载后 `wait`；用工作区/`read_file` 或用户目录确认（视运行时配置）
- 多次点击无文件：换直链 / handover
- 勿用 evaluate 碰浏览器下载权限指纹面
