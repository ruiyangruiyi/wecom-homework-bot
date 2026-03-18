require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const xml2js = require('xml2js');
const { detectHomework, saveHomework } = require('./homework-sync');
const { initSchedules } = require('./homework-reminder');
const { registerHomeworkRoutes } = require('./homework-api');
const { registerClassRoutes } = require('./class-api');
const { syncHomeworkToGroup } = require('./homework-group-sync');

const app = express();
app.use(express.text({ type: 'text/xml' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 从 .env 读取配置
const CORP_ID = process.env.WECOM_CORP_ID;
const AGENT_ID = process.env.WECOM_AGENT_ID;
const SECRET = process.env.WECOM_SECRET;
const TOKEN = process.env.WECOM_TOKEN;
const ENCODING_AES_KEY = process.env.WECOM_AES_KEY;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// 配置检查
const hasConfig = CORP_ID && TOKEN && ENCODING_AES_KEY;
if (!hasConfig) {
  console.warn('⚠️ 企业微信配置不完整，请检查 .env 文件');
}

async function sendToTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    }, { timeout: 10000 });
    console.log('✅ Telegram 消息发送成功');
    return response.data;
  } catch (error) {
    console.error('❌ Telegram 发送失败:', error.message);
    return null;
  }
}

class WXBizMsgCrypt {
  constructor(token, encodingAESKey, corpId) {
    this.token = token;
    this.corpId = corpId;
    this.aesKey = Buffer.from(encodingAESKey + '=', 'base64');
    this.iv = this.aesKey.slice(0, 16);
  }

  getSignature(timestamp, nonce, encrypt = '') {
    const arr = [this.token, timestamp, nonce];
    if (encrypt) arr.push(encrypt);
    arr.sort();
    return crypto.createHash('sha1').update(arr.join('')).digest('hex');
  }

  verifySignature(msgSignature, timestamp, nonce, encrypt) {
    return this.getSignature(timestamp, nonce, encrypt) === msgSignature;
  }

  decrypt(encrypt) {
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.aesKey, this.iv);
    decipher.setAutoPadding(false);
    let decrypted = Buffer.concat([decipher.update(encrypt, 'base64'), decipher.final()]);
    const pad = decrypted[decrypted.length - 1];
    decrypted = decrypted.slice(0, decrypted.length - pad);
    const msgLen = decrypted.readUInt32BE(16);
    return decrypted.slice(20, 20 + msgLen).toString('utf8');
  }

  verifyURL(msgSignature, timestamp, nonce, echostr) {
    if (!this.verifySignature(msgSignature, timestamp, nonce, echostr)) {
      return { code: -1, message: '签名验证失败' };
    }
    try {
      return { code: 0, message: '验证成功', data: this.decrypt(echostr) };
    } catch (error) {
      return { code: -2, message: '解密失败: ' + error.message };
    }
  }

  decryptMsg(msgSignature, timestamp, nonce, encrypt) {
    if (!this.verifySignature(msgSignature, timestamp, nonce, encrypt)) {
      return { code: -1, message: '签名验证失败' };
    }
    try {
      return { code: 0, message: '解密成功', data: this.decrypt(encrypt) };
    } catch (error) {
      return { code: -2, message: '解密失败: ' + error.message };
    }
  }
}

const wxCrypt = hasConfig ? new WXBizMsgCrypt(TOKEN, ENCODING_AES_KEY, CORP_ID) : null;

// 客户群事件处理
async function handleExternalChatEvent(xml) {
  const changeType = xml.ChangeType ? xml.ChangeType[0] : '';
  const chatId = xml.ChatId ? xml.ChatId[0] : '';
  const updateDetail = xml.UpdateDetail ? xml.UpdateDetail[0] : '';
  const joinScene = xml.JoinScene ? xml.JoinScene[0] : '';
  const quitScene = xml.QuitScene ? xml.QuitScene[0] : '';
  const memChangeCnt = xml.MemChangeCnt ? xml.MemChangeCnt[0] : '';

  console.log(`========== 客户群事件 ==========`);
  console.log(`变更类型: ${changeType}`);
  console.log(`群ID: ${chatId}`);
  console.log(`详情: ${updateDetail || joinScene || quitScene}`);

  let telegramMsg = '';
  
  switch (changeType) {
    case 'create':
      telegramMsg = `👥 <b>客户群创建</b>\n\n🆔 群ID: <code>${chatId}</code>\n⏰ 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      break;
    case 'update':
      const updateTypes = {
        'add_member': '新成员加入',
        'del_member': '成员退出',
        'change_owner': '群主变更',
        'change_name': '群名变更',
        'change_notice': '群公告变更'
      };
      const updateDesc = updateTypes[updateDetail] || updateDetail;
      telegramMsg = `👥 <b>客户群变更</b>\n\n🆔 群ID: <code>${chatId}</code>\n📝 变更: ${updateDesc}\n👤 人数变化: ${memChangeCnt || 'N/A'}\n⏰ 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      
      // 如果是新成员加入，记录入群方式
      if (updateDetail === 'add_member' && joinScene) {
        const joinScenes = {
          '1': '群主邀请',
          '2': '扫描群二维码',
          '3': '通过群链接'
        };
        telegramMsg += `\n📍 入群方式: ${joinScenes[joinScene] || joinScene}`;
      }
      break;
    case 'dismiss':
      telegramMsg = `👥 <b>客户群解散</b>\n\n🆔 群ID: <code>${chatId}</code>\n⏰ 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      break;
    default:
      telegramMsg = `👥 <b>客户群事件</b>\n\n🆔 群ID: <code>${chatId}</code>\n📌 类型: ${changeType}\n⏰ 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  }

  await sendToTelegram(telegramMsg);
  console.log('✅ 客户群事件已转发到 Telegram');
}

let accessToken = null;
let tokenExpireTime = 0;

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpireTime) {
    return accessToken;
  }
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${SECRET}`;
  const response = await axios.get(url);
  if (response.data.errcode === 0) {
    accessToken = response.data.access_token;
    tokenExpireTime = Date.now() + (response.data.expires_in - 300) * 1000;
    return accessToken;
  }
  throw new Error('获取 access_token 失败');
}


// 创建企业微信群聊（内部群）
async function createWeComGroup(name, owner, userList) {
  try {
    const token = await getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/appchat/create?access_token=${token}`;
    const payload = { name, owner, userlist: userList };
    console.log('[建群] 请求参数:', JSON.stringify(payload));
    const response = await axios.post(url, payload);
    console.log('[建群] API响应:', JSON.stringify(response.data));
    if (response.data.errcode === 0) {
      return { success: true, chatId: response.data.chatid };
    } else {
      return { success: false, error: response.data.errmsg, errcode: response.data.errcode };
    }
  } catch (error) {
    console.error('[建群] 异常:', error.message);
    return { success: false, error: error.message };
  }
}

// 处理建群指令
async function handleCreateGroupCommand(content, fromUser) {
  const match = content.match(/^建群\s+(.+?)(?:\s+(.+))?$/);
  if (!match) {
    return '建群指令格式：\n建群 群名称 成员1,成员2\n\n例如：建群 测试群 zhangsan,lisi';
  }
  const groupName = match[1].trim();
  let members = [fromUser];
  if (match[2]) {
    const additionalMembers = match[2].split(/[,，\s]+/).map(m => m.trim()).filter(Boolean);
    members = [...new Set([...members, ...additionalMembers])];
  }
  if (members.length < 2) {
    return '❌ 建群至少需要2个成员。\n\n请使用：建群 群名称 成员ID\n例如：建群 测试群 zhangsan';
  }
  const result = await createWeComGroup(groupName, fromUser, members);
  if (result.success) {
    return `✅ 群「${groupName}」创建成功！\n\n群ID: ${result.chatId}\n成员: ${members.join(', ')}\n群主: ${fromUser}`;
  } else {
    return `❌ 建群失败: ${result.error}\n\n错误码: ${result.errcode || 'N/A'}`;
  }
}

async function sendWeComMessage(toUser, content) {
  const token = await getAccessToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
  const response = await axios.post(url, {
    touser: toUser,
    msgtype: 'text',
    agentid: AGENT_ID,
    text: { content }
  });
  console.log(`发送企业微信消息给 ${toUser}: ${response.data.errcode === 0 ? '成功' : '失败'}`);
  return response.data;
}

const AUTO_REPLIES = {
  '你好': '您好，我是教学管理助手，有什么可以帮您的？',
  'hello': '您好，我是教学管理助手，有什么可以帮您的？',
  'hi': '您好，我是教学管理助手，有什么可以帮您的？',
  '帮助': '👋 您好！我是教学管理助手。\n\n📌 可用命令：\n• 你好 - 打招呼\n• 帮助 - 查看帮助\n• 建群 - 创建班级群\n• 状态 - 查看系统状态',
  'help': '👋 您好！我是教学管理助手。\n\n📌 可用命令：\n• 你好 - 打招呼\n• 帮助 - 查看帮助\n• 建群 - 创建班级群\n• 状态 - 查看系统状态',
  '?': '👋 您好！我是教学管理助手。\n\n📌 可用命令：\n• 你好 - 打招呼\n• 帮助 - 查看帮助\n• 建群 - 创建班级群\n• 状态 - 查看系统状态',
  '建群': null,  // 特殊处理
  '状态': null,
};

function getAutoReply(content) {
  const text = content.trim().toLowerCase();
  
  if (AUTO_REPLIES.hasOwnProperty(text)) {
    if (text === '状态') {
      return `✅ 系统运行正常\n⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    }
    return AUTO_REPLIES[text];
  }
  
  if (text.includes('你好') || text.includes('您好')) {
    return '您好，我是教学管理助手，有什么可以帮您的？';
  }
  if (text.includes('谢谢') || text.includes('感谢')) {
    return '不客气，有问题随时找我！';
  }
  if (text.includes('再见') || text.includes('拜拜')) {
    return '再见，祝您生活愉快！';
  }
  
  return `收到您的消息: "${content}"\n\n发送"帮助"查看可用命令。`;
}

// 统一的 URL 验证处理函数
function handleCallbackVerify(req, res, source = 'callback') {
  if (!wxCrypt) {
    return res.status(500).send('企业微信配置未设置');
  }
  const { msg_signature, timestamp, nonce, echostr } = req.query;
  console.log(`========== URL验证请求 (${source}) ==========`);
  
  const result = wxCrypt.verifyURL(msg_signature, timestamp, nonce, echostr);
  if (result.code === 0) {
    console.log(`✅ URL验证成功 (${source})`);
    res.send(result.data);
  } else {
    console.log(`❌ URL验证失败 (${source}):`, result.message);
    res.status(403).send(result.message);
  }
}

// 统一的消息处理函数
async function handleCallbackMessage(req, res, source = 'callback') {
  if (!wxCrypt) {
    return res.send('success');
  }
  const { msg_signature, timestamp, nonce } = req.query;
  console.log(`========== 收到企业微信消息 (${source}) ==========`);

  try {
    const xmlBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const parsed = await xml2js.parseStringPromise(xmlBody);
    const encrypt = parsed.xml.Encrypt[0];

    const result = wxCrypt.decryptMsg(msg_signature, timestamp, nonce, encrypt);
    if (result.code !== 0) {
      console.log('❌ 解密失败:', result.message);
      return res.send('success');
    }

    const msgParsed = await xml2js.parseStringPromise(result.data);
    const msgType = msgParsed.xml.MsgType[0];
    const fromUser = msgParsed.xml.FromUserName[0];
    const chatId = msgParsed.xml.ChatId ? msgParsed.xml.ChatId[0] : 'default';
    const content = msgParsed.xml.Content ? msgParsed.xml.Content[0] : '';
    const event = msgParsed.xml.Event ? msgParsed.xml.Event[0] : '';

    console.log(`消息类型: ${msgType}, 发送者: ${fromUser}, 内容: ${content || event}`);

    // 客户群事件处理：MsgType=event + Event=change_external_chat
    if (msgType === 'event' && event === 'change_external_chat') {
      console.log('📍 检测到客户群事件 (change_external_chat)');
      await handleExternalChatEvent(msgParsed.xml);
      return res.send('success');
    }

    if (msgType === 'text') {
      const homework = detectHomework(content);
      if (homework) {
        console.log('📚 检测到作业消息');
        await saveHomework(homework, chatId, fromUser);
        const telegramMsg = `📚 <b>作业已同步</b>\n\n👤 发布者: <code>${fromUser}</code>\n📝 内容: ${homework.content.substring(0, 100)}\n⏰ 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
        await sendToTelegram(telegramMsg);
        await sendWeComMessage(fromUser, '✅ 作业已同步到系统，学生可以查看了！');
      } else {
        const telegramMsg = `📩 <b>企业微信消息</b>\n\n👤 发送者: <code>${fromUser}</code>\n💬 内容: ${content}\n⏰ 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
        await sendToTelegram(telegramMsg);

        // 特殊处理建群指令
        if (content.trim().startsWith('建群')) {
          const createGroupReply = await handleCreateGroupCommand(content, fromUser);
          await sendWeComMessage(fromUser, createGroupReply);
          return res.send('success');
        }

        const reply = getAutoReply(content);
        if (reply) {
          await sendWeComMessage(fromUser, reply);
        }
      }
    } else if (msgType === 'event') {
      // 其他事件处理
      const telegramMsg = `📩 <b>企业微信事件</b>\n\n👤 用户: <code>${fromUser}</code>\n📌 事件: ${event}\n⏰ 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      await sendToTelegram(telegramMsg);

      if (event === 'subscribe') {
        await sendWeComMessage(fromUser, '👋 欢迎使用教学管理助手！\n\n发送"帮助"查看可用命令。');
      }
    }

    res.send('success');
  } catch (error) {
    console.error('处理消息异常:', error);
    res.send('success');
  }
}

app.get('/api/wecom/callback', (req, res) => handleCallbackVerify(req, res, 'api/wecom/callback'));

app.post('/api/wecom/callback', (req, res) => handleCallbackMessage(req, res, 'api/wecom/callback'));

// /edu/wecom/callback - 统一回调端点（支持客户群事件）
// 通过 MsgType=event + Event=change_external_chat 区分客户群事件
app.get('/edu/wecom/callback', (req, res) => handleCallbackVerify(req, res, 'edu/wecom/callback'));
app.post('/edu/wecom/callback', (req, res) => handleCallbackMessage(req, res, 'edu/wecom/callback'));

app.post('/api/wecom/send', async (req, res) => {
  try {
    const { touser, content } = req.body;
    const result = await sendWeComMessage(touser || '@all', content);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    corpId: CORP_ID,
    agentId: AGENT_ID,
    hasToken: !!TOKEN,
    hasAesKey: !!ENCODING_AES_KEY,
    hasCorpId: !!CORP_ID,
    features: ['telegram_forward', 'auto_reply', 'homework_sync', 'homework_reminder', 'external_chat_event']
  });
});

// [废弃] 客户群事件回调端点 - 已合并到 /edu/wecom/callback
// 保留此端点以兼容旧配置，建议迁移到 /edu/wecom/callback
app.get('/api/wecom/external-chat', (req, res) => {
  console.log('⚠️ /api/wecom/external-chat 已废弃，请使用 /edu/wecom/callback');
  handleCallbackVerify(req, res, 'external-chat(deprecated)');
});

app.post('/api/wecom/external-chat', (req, res) => {
  console.log('⚠️ /api/wecom/external-chat 已废弃，请使用 /edu/wecom/callback');
  handleCallbackMessage(req, res, 'external-chat(deprecated)');
});

app.get('/', (req, res) => {
  res.json({
    name: '英语培训系统 - 企业微信服务',
    status: 'running',
    features: ['消息转发到Telegram', '自动回复', '作业同步', '作业提醒', '客户群事件(统一处理)'],
    endpoints: {
      callback: '/api/wecom/callback',
      eduCallback: '/edu/wecom/callback (推荐，支持客户群事件)',
      externalChat: '/api/wecom/external-chat (已废弃)',
      send: '/api/wecom/send',
      health: '/health'
    },
    note: '客户群事件已合并到 /edu/wecom/callback，通过 MsgType=event + Event=change_external_chat 自动识别'
  });
});

const PORT = process.env.PORT || 3000;

// 注册作业 CRUD 路由
registerHomeworkRoutes(app);

// 注册班级管理路由
registerClassRoutes(app);

app.listen(PORT, () => {
  console.log('==========================================');
  console.log('  英语培训系统 - 企业微信服务 v6.0');
  console.log('==========================================');
  console.log(`🚀 服务启动成功，端口: ${PORT}`);
  console.log(`📍 应用回调: http://101.32.253.147/api/wecom/callback`);
  console.log(`📍 统一回调: http://101.32.253.147/edu/wecom/callback (推荐)`);
  console.log(`📍 客户群回调: http://101.32.253.147/api/wecom/external-chat (已废弃)`);
  console.log(`📱 Telegram 转发: ${TELEGRAM_CHAT_ID || '未配置'}`);
  console.log(`🤖 自动回复: 已启用`);
  console.log(`📚 作业同步: 已启用`);
  console.log(`⏰ 作业提醒: 已启用 (18:00, 20:00)`);
  console.log(`👥 客户群事件: 已统一到 /edu/wecom/callback`);
  console.log(`🔧 配置状态: ${hasConfig ? '✅ 完整' : '⚠️ 不完整'}`);
  console.log('==========================================');
  console.log('📌 客户群事件通过 MsgType=event + Event=change_external_chat 自动识别');
  console.log('==========================================');
  
  initSchedules();
});
