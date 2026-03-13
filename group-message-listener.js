/**
 * 客户群消息监听服务
 * 通过会话存档 API 轮询获取群消息
 * 
 * 注意：需要开通企业微信「会话存档」功能（付费）
 * 文档：https://developer.work.weixin.qq.com/document/path/91774
 */

const axios = require('axios');
const crypto = require('crypto');
const { detectHomework, saveHomework } = require('./homework-sync');

// 配置
const CORP_ID = process.env.WECOM_CORP_ID;
const CHAT_SECRET = process.env.WECOM_CHAT_SECRET; // 会话存档 Secret
const PRIVATE_KEY = process.env.WECOM_PRIVATE_KEY; // RSA 私钥（用于解密消息）

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// 存储上次拉取的 seq
let lastSeq = 0;

// 获取会话存档 access_token
let chatAccessToken = null;
let chatTokenExpireTime = 0;

async function getChatAccessToken() {
  if (chatAccessToken && Date.now() < chatTokenExpireTime) {
    return chatAccessToken;
  }
  
  if (!CHAT_SECRET) {
    console.log('⚠️ 会话存档 Secret 未配置');
    return null;
  }
  
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${CHAT_SECRET}`;
  const response = await axios.get(url);
  
  if (response.data.errcode === 0) {
    chatAccessToken = response.data.access_token;
    chatTokenExpireTime = Date.now() + (response.data.expires_in - 300) * 1000;
    return chatAccessToken;
  }
  
  console.error('获取会话存档 token 失败:', response.data);
  return null;
}

// 拉取聊天记录
async function fetchChatData(seq = 0, limit = 100) {
  const token = await getChatAccessToken();
  if (!token) return null;
  
  const url = `https://qyapi.weixin.qq.com/cgi-bin/msgaudit/get_permit_user_list?access_token=${token}`;
  
  // 注意：实际使用需要调用 SDK 或使用 C++ 库解密
  // 这里是简化版本，实际需要：
  // 1. 调用 getchatdata 获取加密消息
  // 2. 使用 RSA 私钥解密 encrypt_random_key
  // 3. 使用解密后的 key 解密消息内容
  
  console.log('[会话存档] 功能需要企业微信付费开通');
  return null;
}

// 发送到 Telegram
async function sendToTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    }, { timeout: 10000 });
    return response.data;
  } catch (error) {
    console.error('Telegram 发送失败:', error.message);
    return null;
  }
}

// 处理群消息
async function processGroupMessage(msg) {
  const { roomid, from, content, msgtime } = msg;
  
  console.log(`[群消息] 群:${roomid} 发送者:${from} 内容:${content.substring(0, 50)}...`);
  
  // 检测作业
  const homework = detectHomework(content);
  if (homework) {
    console.log('📚 检测到作业消息');
    
    // 保存到 Redis
    const homeworkId = await saveHomework(homework, roomid, from);
    
    // 同步到 Telegram
    const telegramMsg = `📚 <b>作业已同步</b>\n\n👤 发布者: <code>${from}</code>\n🏠 群: <code>${roomid}</code>\n📝 内容: ${homework.content.substring(0, 200)}\n⏰ 时间: ${new Date(msgtime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    await sendToTelegram(telegramMsg);
    
    return { type: 'homework', homeworkId };
  }
  
  return { type: 'normal' };
}

// 启动监听（轮询模式）
async function startListener(intervalMs = 60000) {
  console.log('[群消息监听] 启动中...');
  
  const token = await getChatAccessToken();
  if (!token) {
    console.log('[群消息监听] ❌ 会话存档未配置或未开通');
    console.log('[群消息监听] 需要：');
    console.log('  1. 在企业微信管理后台开通「会话存档」功能');
    console.log('  2. 配置 WECOM_CHAT_SECRET 环境变量');
    console.log('  3. 配置 WECOM_PRIVATE_KEY 环境变量（RSA 私钥）');
    return;
  }
  
  console.log('[群消息监听] ✅ 已连接，开始轮询...');
  
  setInterval(async () => {
    try {
      const messages = await fetchChatData(lastSeq);
      if (messages && messages.length > 0) {
        for (const msg of messages) {
          if (msg.msgtype === 'text' && msg.roomid) {
            await processGroupMessage(msg);
          }
          lastSeq = Math.max(lastSeq, msg.seq);
        }
      }
    } catch (error) {
      console.error('[群消息监听] 轮询异常:', error.message);
    }
  }, intervalMs);
}

module.exports = {
  startListener,
  processGroupMessage,
  fetchChatData,
  getChatAccessToken
};
