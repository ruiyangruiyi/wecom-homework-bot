# Changelog

本项目的所有重要更改都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.2.0] - 2026-03-13

### 新增

- 🔗 客户群列表 API (`GET /api/customer-groups`)
- 🔗 客户群二维码生成 API (`POST /api/customer-groups/:chatId/qrcode`)

### 变更

- 📝 重写 README 文档，突出说明建群需要手动操作
- 📝 添加详细的使用流程说明
- 📝 解释企业微信 API 限制原因

## [1.1.0] - 2026-03-13

### 新增

- 🏠 内部群创建 API (`/api/group/create`)
- 📋 企业微信用户列表查询

### 变更

- 📝 更新 README，说明外部群需要手动创建

## [1.0.0] - 2026-03-13

### 新增

- 🎉 首次发布
- 📚 作业同步功能 - 自动识别并保存作业消息到 Redis
- ⏰ 定时提醒功能 - 每日 18:00/20:00 自动提醒学生完成作业
- 💬 自动回复功能 - 智能回复常见问题
- 📱 Telegram 转发 - 将企业微信消息同步到 Telegram 群组
- 🔐 消息加解密 - 完整支持企业微信消息加解密
- 🏥 健康检查接口 - `/health` 端点用于监控服务状态

### 技术栈

- Node.js + Express
- Redis (ioredis)
- node-cron 定时任务
- 企业微信 API
- Telegram Bot API
