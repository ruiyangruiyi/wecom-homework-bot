# Changelog

本项目的所有重要更改都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-03-13

### 新增

- 🎉 首次发布
- 📚 作业同步功能 - 自动识别并保存作业消息到 Redis
- ⏰ 定时提醒功能 - 每日 18:00/20:00 自动提醒学生完成作业
- 💬 自动回复功能 - 智能回复常见问题（你好、帮助、状态等）
- 📱 Telegram 转发 - 将企业微信消息同步到 Telegram 群组
- 🏠 建群功能 - 通过指令快速创建企业微信群聊
- 🔐 消息加解密 - 完整支持企业微信消息加解密
- 🏥 健康检查接口 - `/health` 端点用于监控服务状态

### 技术栈

- Node.js + Express
- Redis (ioredis)
- node-cron 定时任务
- 企业微信 API
- Telegram Bot API

### 测试结果

- ✅ 消息接收与自动回复
- ✅ 作业识别与同步
- ✅ Telegram 消息转发
- ✅ 定时任务调度
- ✅ 健康检查接口
- ⚠️ 建群功能（需要企业微信后台开启"客户联系"权限）
