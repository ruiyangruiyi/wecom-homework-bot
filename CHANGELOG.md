# Changelog

本项目的所有重要更改都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-03-13

### 新增

- 🏠 内部群创建 API (`/api/group/create`)
- 📋 企业微信用户列表查询
- 📖 完善使用流程文档

### 变更

- 📝 更新 README，说明外部群需要手动创建
- 🔧 优化建群指令帮助信息

### 已知限制

- ⚠️ 外部客户群需要手动在企业微信 App 中创建
- ⚠️ 群活码功能需要「客户联系」权限

## [1.0.0] - 2026-03-13

### 新增

- 🎉 首次发布
- 📚 作业同步功能 - 自动识别并保存作业消息到 Redis
- ⏰ 定时提醒功能 - 每日 18:00/20:00 自动提醒学生完成作业
- 💬 自动回复功能 - 智能回复常见问题（你好、帮助、状态等）
- 📱 Telegram 转发 - 将企业微信消息同步到 Telegram 群组
- 🔐 消息加解密 - 完整支持企业微信消息加解密
- 🏥 健康检查接口 - `/health` 端点用于监控服务状态

### 技术栈

- Node.js + Express
- Redis (ioredis)
- node-cron 定时任务
- 企业微信 API
- Telegram Bot API
