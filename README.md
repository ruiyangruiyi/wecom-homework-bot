# 企业微信作业管理机器人

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

一个基于企业微信的教学作业管理系统，支持作业同步、自动提醒、消息转发等功能。

## ✨ 功能特性

- 📚 **作业同步** - 自动识别并保存作业消息到 Redis
- ⏰ **定时提醒** - 每日 18:00/20:00 自动提醒学生完成作业
- 💬 **自动回复** - 智能回复常见问题
- 📱 **Telegram 转发** - 将企业微信消息同步到 Telegram
- 🏠 **建群功能** - 通过指令快速创建班级群

## 🚀 快速开始

### 环境要求

- Node.js >= 18
- Redis >= 6
- 企业微信自建应用

### 安装

```bash
# 克隆仓库
git clone https://github.com/ruiyangruiyi/wecom-homework-bot.git
cd wecom-homework-bot

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入你的配置
```

### 配置

创建 `.env` 文件：

```env
# 企业微信配置
WECOM_CORP_ID=你的企业ID
WECOM_AGENT_ID=应用AgentID
WECOM_SECRET=应用Secret
WECOM_TOKEN=回调Token
WECOM_AES_KEY=回调EncodingAESKey

# Telegram 转发（可选）
TELEGRAM_BOT_TOKEN=你的Bot Token
TELEGRAM_CHAT_ID=目标群组ID

# 服务端口
PORT=3000
```

### 启动

```bash
# 开发模式
node server.js

# 生产模式（推荐使用 PM2）
pm2 start server.js --name wecom-bot
```

## 📖 API 文档

### 回调接口

企业微信回调地址配置为：`http://你的域名/api/wecom/callback`

#### GET /api/wecom/callback

URL 验证接口，企业微信配置回调时自动调用。

#### POST /api/wecom/callback

消息接收接口，处理企业微信推送的消息和事件。

### 主动发送消息

#### POST /api/wecom/send

发送企业微信消息。

**请求体：**
```json
{
  "touser": "用户ID或@all",
  "content": "消息内容"
}
```

**响应：**
```json
{
  "errcode": 0,
  "errmsg": "ok"
}
```

### 健康检查

#### GET /health

返回服务状态信息。

**响应：**
```json
{
  "status": "ok",
  "time": "2026-03-13T04:00:00.000Z",
  "features": ["telegram_forward", "auto_reply", "homework_sync", "homework_reminder"]
}
```

## 💬 指令说明

在企业微信中发送以下指令：

| 指令 | 说明 | 示例 |
|------|------|------|
| `你好` | 打招呼 | 你好 |
| `帮助` | 查看帮助 | 帮助 |
| `状态` | 查看系统状态 | 状态 |
| `建群 群名 成员` | 创建群聊 | 建群 三年级一班 zhangsan,lisi |

## 📚 作业识别

系统自动识别以下格式的作业消息：

- `【作业】...`
- `#作业 ...`
- `今日作业：...`
- `作业布置：...`
- `布置作业 ...`
- `homework: ...`

识别到作业后会自动保存到 Redis，并同步到 Telegram。

## 🏗️ 项目结构

```
wecom-homework-bot/
├── server.js           # 主服务入口
├── homework-sync.js    # 作业同步模块
├── homework-reminder.js # 作业提醒模块
├── package.json        # 项目配置
├── .env.example        # 环境变量示例
└── README.md           # 项目文档
```

## 🔧 部署指南

### 使用 PM2 部署

```bash
# 安装 PM2
npm install -g pm2

# 启动服务
pm2 start server.js --name wecom-bot

# 设置开机自启
pm2 startup
pm2 save
```

### 使用 Nginx 反向代理

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## 📝 更新日志

查看 [CHANGELOG.md](./CHANGELOG.md)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

[MIT License](./LICENSE)
