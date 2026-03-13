require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const xml2js = require('xml2js');
const { detectHomework, saveHomework } = require('./homework-sync');
const { initSchedules } = require('./homework-reminder');

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

// 用户会话状态（存储群列表选择上下文）
const userSessions = new Map();
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5分钟超时

function setUserSession(userId, data) {
  userSessions.set(userId, { ...data, timestamp: Date.now() });
}

function getUserSession(userId) {
  const session = userSessions.get(userId);
  if (!session) return null;
  if (Date.now() - session.timestamp > SESSION_TIMEOUT) {
    userSessions.delete(userId);
    return null;
  }
  return session;
}

function clearUserSession(userId) {
  userSessions.delete(userId);
}

// 定期清理过期会话（每10分钟）
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of userSessions.entries()) {
    if (now - session.timestamp > SESSION_TIMEOUT) {
      userSessions.delete(userId);
    }
  }
}, 10 * 60 * 1000);

// 主菜单配置
const MAIN_MENU = [
  { id: 1, name: '群二维码', desc: '获取外部群入群码', trigger: 'qrcode' },
  { id: 2, name: '发作业', desc: '发布作业到群', trigger: 'homework' },
  { id: 3, name: '系统状态', desc: '查看运行状态', trigger: 'status' },
  { id: 4, name: '建内部群', desc: '仅限企业成员', trigger: 'creategroup' },
];

// 生成主菜单文本
function getMainMenuText() {
  const list = MAIN_MENU.map(item => `${item.id}. ${item.name}`).join('\n');
  return `📌 功能菜单：\n${list}\n\n回复数字选择`;
}

// 处理菜单选择
async function handleMenuSelection(content, fromUser) {
  const session = getUserSession(fromUser);
  if (!session || session.type !== 'main_menu') {
    return null;
  }
  
  const num = parseInt(content.trim());
  if (isNaN(num) || num < 1 || num > MAIN_MENU.length) {
    return null;
  }
  
  clearUserSession(fromUser);
  const selected = MAIN_MENU[num - 1];
  
  switch (selected.trigger) {
    case 'qrcode':
      return { type: 'redirect', command: 'qr' };
    case 'homework':
      // 进入发作业流程
      setUserSession(fromUser, { type: 'homework_select_group' });
      return { type: 'redirect', command: 'homework_start' };
    case 'creategroup':
      return { type: 'text', content: '📝 建内部群（仅限企业成员）\n\n格式：建群 群名 成员1,成员2\n例如：建群 测试群 zhangsan,lisi' };
    case 'status':
      return { type: 'text', content: `✅ 系统运行正常\n⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` };
    default:
      return null;
  }
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


// 获取客户群列表
async function getCustomerGroups() {
  try {
    const token = await getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/externalcontact/groupchat/list?access_token=${token}`;
    const response = await axios.post(url, {
      status_filter: 0,
      limit: 100
    });
    if (response.data.errcode !== 0) {
      return { success: false, error: response.data.errmsg };
    }
    // 获取每个群的详情
    const groups = [];
    for (const item of response.data.group_chat_list || []) {
      const detailUrl = `https://qyapi.weixin.qq.com/cgi-bin/externalcontact/groupchat/get?access_token=${token}`;
      const detailRes = await axios.post(detailUrl, { chat_id: item.chat_id, need_name: 1 });
      if (detailRes.data.errcode === 0) {
        groups.push({
          chatId: item.chat_id,
          name: detailRes.data.group_chat.name || '未命名群',
          memberCount: detailRes.data.group_chat.member_list?.length || 0
        });
      }
    }
    return { success: true, groups };
  } catch (error) {
    console.error('[客户群列表] 异常:', error.message);
    return { success: false, error: error.message };
  }
}

// 生成客户群二维码
async function getGroupQrcode(chatId) {
  try {
    const token = await getAccessToken();
    console.log('[群二维码] chatId:', chatId);
    
    // 创建入群方式
    const addUrl = `https://qyapi.weixin.qq.com/cgi-bin/externalcontact/groupchat/add_join_way?access_token=${token}`;
    const addPayload = {
      scene: 2,
      chat_id_list: [chatId],
      auto_create_room: 0
    };
    console.log('[群二维码] 创建入群方式请求:', JSON.stringify(addPayload));
    const addRes = await axios.post(addUrl, addPayload);
    console.log('[群二维码] 创建入群方式响应:', JSON.stringify(addRes.data));
    
    if (addRes.data.errcode !== 0) {
      return { success: false, error: addRes.data.errmsg, errcode: addRes.data.errcode };
    }
    
    // 获取二维码
    const configId = addRes.data.config_id;
    const getUrl = `https://qyapi.weixin.qq.com/cgi-bin/externalcontact/groupchat/get_join_way?access_token=${token}`;
    console.log('[群二维码] 获取二维码请求 config_id:', configId);
    const getRes = await axios.post(getUrl, { config_id: configId });
    console.log('[群二维码] 获取二维码响应:', JSON.stringify(getRes.data));
    
    if (getRes.data.errcode === 0 && getRes.data.join_way?.qr_code) {
      return { success: true, qrcodeUrl: getRes.data.join_way.qr_code };
    }
    return { success: false, error: getRes.data.errmsg || '获取二维码失败' };
  } catch (error) {
    console.error('[群二维码] 异常:', error.message);
    return { success: false, error: error.message };
  }
}

// 上传媒体文件到企业微信
async function uploadMedia(imageUrl, type = 'image') {
  try {
    const token = await getAccessToken();
    // 下载图片
    const imageRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageRes.data);
    
    // 上传到企业微信
    const FormData = require('form-data');
    const form = new FormData();
    form.append('media', imageBuffer, { filename: 'qrcode.png', contentType: 'image/png' });
    
    const uploadUrl = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=${type}`;
    const uploadRes = await axios.post(uploadUrl, form, {
      headers: form.getHeaders()
    });
    
    if (uploadRes.data.errcode && uploadRes.data.errcode !== 0) {
      return { success: false, error: uploadRes.data.errmsg };
    }
    return { success: true, mediaId: uploadRes.data.media_id };
  } catch (error) {
    console.error('[上传媒体] 异常:', error.message);
    return { success: false, error: error.message };
  }
}

// 发送图片消息
async function sendWeComImage(toUser, mediaId) {
  const token = await getAccessToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
  const response = await axios.post(url, {
    touser: toUser,
    msgtype: 'image',
    agentid: AGENT_ID,
    image: { media_id: mediaId }
  });
  return response.data;
}

// 处理群二维码指令
// 检查是否是二维码指令（支持多种触发词）
function isQrcodeCommand(text) {
  const t = text.trim().toLowerCase();
  // 支持：群二维码、二维码、qr、/qr
  return /^(群二维码|二维码|\/qr|qr)(\s|$)/i.test(t);
}

// ========== 发作业功能 ==========

// 发送消息到客户群（通过群发接口）
async function sendMessageToCustomerGroup(chatId, groupName, message) {
  try {
    const token = await getAccessToken();
    // 使用客户群群发接口
    const url = `https://qyapi.weixin.qq.com/cgi-bin/externalcontact/add_msg_template?access_token=${token}`;
    
    const response = await axios.post(url, {
      chat_type: 'group',
      chat_id_list: [chatId],
      text: {
        content: message
      }
    });
    
    if (response.data.errcode === 0) {
      console.log(`✅ 消息已发送到群「${groupName}」`);
      return { success: true };
    } else {
      console.error(`❌ 发送群消息失败: ${response.data.errmsg}`);
      return { success: false, error: response.data.errmsg, errcode: response.data.errcode };
    }
  } catch (error) {
    console.error('发送群消息异常:', error.message);
    return { success: false, error: error.message };
  }
}

// 处理作业转发选择
async function handleHomeworkForwardSelection(content, fromUser) {
  const session = getUserSession(fromUser);
  if (!session || session.type !== 'homework_forward') {
    return null;
  }
  
  const num = parseInt(content.trim());
  
  // 跳过转发
  if (num === 0) {
    clearUserSession(fromUser);
    return { type: 'text', content: '✅ 已跳过转发，作业已保存到系统' };
  }
  
  if (isNaN(num) || num < 1 || num > session.groups.length) {
    return null;
  }
  
  const group = session.groups[num - 1];
  clearUserSession(fromUser);
  
  // 发送到客户群
  const forwardMsg = `📚 作业通知\n\n${session.homeworkContent}\n\n⏰ 发布时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  const result = await sendMessageToCustomerGroup(group.chat_id, group.name, forwardMsg);
  
  if (result.success) {
    // 同步到 Telegram
    await sendToTelegram(`📤 <b>作业已转发</b>\n\n🏠 群: ${group.name}\n📝 内容: ${session.homeworkContent.substring(0, 100)}...`);
    return { type: 'text', content: `✅ 作业已转发到「${group.name}」！` };
  } else {
    // 如果群发接口失败，尝试提示手动转发
    return { 
      type: 'text', 
      content: `⚠️ 自动转发失败（${result.error || '权限不足'}）\n\n请手动复制以下内容到群里：\n\n${forwardMsg}` 
    };
  }
}

// 处理发作业流程 - 第一步：提示输入作业内容
async function handleHomeworkStart(fromUser) {
  setUserSession(fromUser, { type: 'homework_input_first' });
  return { type: 'text', content: '📚 发作业\n\n请输入作业内容：' };
}

// 处理作业内容输入 - 第二步：输入内容后选群
async function handleHomeworkContentInput(content, fromUser) {
  const session = getUserSession(fromUser);
  if (!session || session.type !== 'homework_input_first') {
    return null;
  }
  
  // 获取群列表供选择
  const result = await getCustomerGroups();
  if (!result.success) {
    clearUserSession(fromUser);
    return { type: 'text', content: `❌ 获取群列表失败: ${result.error}` };
  }
  
  if (result.groups.length === 0) {
    clearUserSession(fromUser);
    return { type: 'text', content: '暂无外部群，请先创建群' };
  }
  
  const list = result.groups.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
  setUserSession(fromUser, { type: 'homework_select_group', groups: result.groups, homeworkContent: content });
  return { type: 'text', content: `✅ 作业内容已记录\n\n📋 选择要发送到的群：\n${list}\n\n回复序号选择，回复「0」取消` };
}

// 处理群选择 - 第三步：选群后转发
async function handleHomeworkGroupSelection(content, fromUser) {
  const session = getUserSession(fromUser);
  if (!session || session.type !== 'homework_select_group') {
    return null;
  }
  
  const num = parseInt(content.trim());
  
  // 取消
  if (num === 0) {
    clearUserSession(fromUser);
    return { type: 'text', content: '已取消发作业' };
  }
  
  if (isNaN(num) || num < 1 || num > session.groups.length) {
    return null;
  }
  
  const group = session.groups[num - 1];
  const homeworkContent = session.homeworkContent;
  clearUserSession(fromUser);
  
  // 保存作业
  const homework = detectHomework(homeworkContent) || { raw: homeworkContent, content: homeworkContent, pattern: 'direct' };
  const homeworkId = await saveHomework(homework, group.chat_id, fromUser);
  
  // 格式化作业内容，方便复制
  const formattedHomework = `📚 作业通知\n\n${homeworkContent}\n\n⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  
  // 同步到 Telegram
  await sendToTelegram(`📤 <b>作业已保存</b>\n\n🏠 群: ${group.name}\n📝 内容: ${homeworkContent.substring(0, 100)}...`);
  
  // 返回提示，引导老师去群发助手发送
  return { 
    type: 'text', 
    content: `✅ 作业已保存！\n\n🏠 目标群：${group.name}\n\n📋 请复制以下内容，通过「群发助手」发送到群：\n\n${formattedHomework}\n\n💡 操作：企业微信 → 工作台 → 群发助手` 
  };
}

// 处理作业内容输入（旧流程，保留兼容）
async function handleHomeworkInput(content, fromUser) {
  const session = getUserSession(fromUser);
  if (!session || session.type !== 'homework_input') {
    return null;
  }
  
  const group = session.group;
  clearUserSession(fromUser);
  
  // 检测作业格式
  const homework = detectHomework(content);
  const homeworkContent = homework ? homework.content : content;
  
  // 保存到 Redis
  const homeworkId = await saveHomework(
    { raw: content, content: homeworkContent, pattern: homework?.pattern || 'direct' },
    group.chatId,
    fromUser
  );
  
  // 同步到 Telegram
  const telegramMsg = `📚 <b>作业已发布</b>\n\n👤 发布者: <code>${fromUser}</code>\n🏠 群: ${group.name}\n📝 内容:\n${homeworkContent.substring(0, 500)}\n⏰ 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  await sendToTelegram(telegramMsg);
  
  // TODO: 发送到客户群（需要群机器人 Webhook 或 appchat/send 权限）
  // 目前先返回成功，后续接入群消息发送
  
  return { 
    type: 'text', 
    content: `✅ 作业已保存！\n\n📋 作业ID: ${homeworkId}\n🏠 目标群: ${group.name}\n\n⚠️ 注意：自动发送到群功能开发中，请手动复制到群里` 
  };
}

// ========== 二维码功能 ==========

// 提取群名参数
function extractGroupName(text) {
  const t = text.trim();
  const match = t.match(/^(群二维码|二维码|\/qr|qr)\s+(.+)$/i);
  return match ? match[2].trim() : null;
}

async function handleQrcodeCommand(content, fromUser) {
  const groupName = extractGroupName(content);
  
  // 获取群列表
  const result = await getCustomerGroups();
  if (!result.success) {
    return { type: 'text', content: `❌ 获取群列表失败: ${result.error}` };
  }
  
  if (result.groups.length === 0) {
    return { type: 'text', content: '暂无外部群' };
  }
  
  // 如果没指定群名，返回群列表并保存会话
  if (!groupName) {
    const list = result.groups.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
    // 保存群列表到用户会话
    setUserSession(fromUser, { type: 'qrcode_select', groups: result.groups });
    return { type: 'text', content: `📋 外部群：\n${list}\n\n回复序号获取二维码` };
  }
  
  // 查找匹配的群
  const group = result.groups.find(g => g.name.includes(groupName));
  if (!group) {
    return { type: 'text', content: `❌ 未找到包含「${groupName}」的群` };
  }
  
  return await getQrcodeForGroup(group);
}

// 处理序号选择
async function handleQrcodeSelection(content, fromUser) {
  const session = getUserSession(fromUser);
  if (!session || session.type !== 'qrcode_select') {
    return null; // 没有待选择的会话
  }
  
  const num = parseInt(content.trim());
  if (isNaN(num) || num < 1 || num > session.groups.length) {
    return null; // 不是有效序号
  }
  
  const group = session.groups[num - 1];
  clearUserSession(fromUser); // 清除会话
  return await getQrcodeForGroup(group);
}

// 获取指定群的二维码
async function getQrcodeForGroup(group) {
  const qrResult = await getGroupQrcode(group.chatId);
  if (!qrResult.success) {
    return { type: 'text', content: `❌ 获取二维码失败: ${qrResult.error}` };
  }
  
  // 上传图片并发送
  const uploadResult = await uploadMedia(qrResult.qrcodeUrl);
  if (!uploadResult.success) {
    // 上传失败，返回链接
    return { type: 'text', content: `📱 「${group.name}」入群二维码：\n${qrResult.qrcodeUrl}` };
  }
  
  return { type: 'image', mediaId: uploadResult.mediaId, groupName: group.name };
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
  '你好': null,  // 特殊处理，显示菜单
  'hello': null,
  'hi': null,
  '帮助': null,
  'help': null,
  '?': null,
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

app.get('/api/wecom/callback', (req, res) => {
  if (!wxCrypt) {
    return res.status(500).send('企业微信配置未设置');
  }
  const { msg_signature, timestamp, nonce, echostr } = req.query;
  console.log('========== URL验证请求 ==========');
  
  const result = wxCrypt.verifyURL(msg_signature, timestamp, nonce, echostr);
  if (result.code === 0) {
    console.log('✅ URL验证成功');
    res.send(result.data);
  } else {
    console.log('❌ URL验证失败:', result.message);
    res.status(403).send(result.message);
  }
});

app.post('/api/wecom/callback', async (req, res) => {
  if (!wxCrypt) {
    return res.send('success');
  }
  const { msg_signature, timestamp, nonce } = req.query;
  console.log('========== 收到企业微信消息 ==========');

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
    console.log('[TEST] 消息处理开始，msgType:', msgType);

    if (msgType === 'text') {
      // 先检查是否在作业转发流程中
      const homeworkForwardReply = await handleHomeworkForwardSelection(content, fromUser);
      if (homeworkForwardReply) {
        await sendWeComMessage(fromUser, homeworkForwardReply.content);
        return res.send('success');
      }

      // 单独「作业」关键词触发发作业流程（优先处理）
      const contentTrimmed = content.trim();
      if (contentTrimmed === '作业' || contentTrimmed === '发作业' || contentTrimmed === '布置作业') {
        console.log('[作业] 单独关键词触发，进入发作业流程');
        const hwReply = await handleHomeworkStart(fromUser);
        await sendWeComMessage(fromUser, hwReply.content);
        return res.send('success');
      }

      const homework = detectHomework(content);
      if (homework) {
        console.log('📚 检测到作业消息');
        // 保存作业并询问转发到哪个群
        const homeworkId = await saveHomework(homework, 'pending', fromUser);
        const telegramMsg = `📚 <b>作业已同步</b>\n\n👤 发布者: <code>${fromUser}</code>\n📝 内容: ${homework.content.substring(0, 100)}\n⏰ 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
        await sendToTelegram(telegramMsg);
        
        // 获取群列表供选择
        const result = await getCustomerGroups();
        if (result.success && result.groups.length > 0) {
          const list = result.groups.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
          setUserSession(fromUser, { 
            type: 'homework_forward', 
            groups: result.groups, 
            homeworkId,
            homeworkContent: homework.content 
          });
          await sendWeComMessage(fromUser, `✅ 作业已保存！\n\n📋 选择要转发到的群：\n${list}\n\n回复序号转发，回复「0」跳过`);
        } else {
          await sendWeComMessage(fromUser, '✅ 作业已保存！\n\n⚠️ 暂无可转发的群');
        }
        return res.send('success');
      } else {
        const telegramMsg = `📩 <b>企业微信消息</b>\n\n👤 发送者: <code>${fromUser}</code>\n💬 内容: ${content}\n⏰ 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
        await sendToTelegram(telegramMsg);

        // 单独「作业」关键词触发发作业流程
        // 特殊处理建群指令
        if (content.trim().startsWith('建群')) {
          const createGroupReply = await handleCreateGroupCommand(content, fromUser);
          await sendWeComMessage(fromUser, createGroupReply);
          return res.send('success');
        }

        // 检查是否是菜单选择
        const menuReply = await handleMenuSelection(content, fromUser);
        if (menuReply) {
          if (menuReply.type === 'redirect') {
            // 重定向到其他命令
            if (menuReply.command === 'homework_start') {
              const hwReply = await handleHomeworkStart(fromUser);
              await sendWeComMessage(fromUser, hwReply.content);
            } else {
              const qrReply = await handleQrcodeCommand(menuReply.command, fromUser);
              if (qrReply.type === 'image') {
                await sendWeComMessage(fromUser, `📱 「${qrReply.groupName}」入群二维码：`);
                await sendWeComImage(fromUser, qrReply.mediaId);
              } else {
                await sendWeComMessage(fromUser, qrReply.content);
              }
            }
          } else {
            await sendWeComMessage(fromUser, menuReply.content);
          }
          return res.send('success');
        }

        // 检查是否是序号选择（群二维码）
        const selectionReply = await handleQrcodeSelection(content, fromUser);
        if (selectionReply) {
          if (selectionReply.type === 'image') {
            await sendWeComMessage(fromUser, `📱 「${selectionReply.groupName}」入群二维码：`);
            await sendWeComImage(fromUser, selectionReply.mediaId);
          } else {
            await sendWeComMessage(fromUser, selectionReply.content);
          }
          return res.send('success');
        }

        // 检查是否是发作业流程中的内容输入（新流程：先输入内容）
        const homeworkContentReply = await handleHomeworkContentInput(content, fromUser);
        if (homeworkContentReply) {
          await sendWeComMessage(fromUser, homeworkContentReply.content);
          return res.send('success');
        }

        // 检查是否是发作业流程中的群选择
        const homeworkGroupReply = await handleHomeworkGroupSelection(content, fromUser);
        if (homeworkGroupReply) {
          await sendWeComMessage(fromUser, homeworkGroupReply.content);
          return res.send('success');
        }

        // 检查是否是发作业流程中的内容输入（旧流程，保留兼容）
        const homeworkInputReply = await handleHomeworkInput(content, fromUser);
        if (homeworkInputReply) {
          await sendWeComMessage(fromUser, homeworkInputReply.content);
          return res.send('success');
        }

        // 特殊处理群二维码指令（支持：群二维码、二维码、qr）
        if (isQrcodeCommand(content)) {
          const qrReply = await handleQrcodeCommand(content, fromUser);
          if (qrReply.type === 'image') {
            await sendWeComMessage(fromUser, `📱 「${qrReply.groupName}」入群二维码：`);
            await sendWeComImage(fromUser, qrReply.mediaId);
          } else {
            await sendWeComMessage(fromUser, qrReply.content);
          }
          return res.send('success');
        }

        // 检查是否是帮助触发词，显示主菜单
        const helpTriggers = ['h', '0', '?', '？', '你好', '您好', 'hello', 'hi', '帮助', 'help', '菜单'];
        const contentLower = content.trim().toLowerCase();
        if (helpTriggers.some(t => t.toLowerCase() === contentLower)) {
          setUserSession(fromUser, { type: 'main_menu' });
          await sendWeComMessage(fromUser, getMainMenuText());
          return res.send('success');
        }

        // 无法识别的消息，返回帮助菜单
        setUserSession(fromUser, { type: 'main_menu' });
        await sendWeComMessage(fromUser, getMainMenuText());
      }
    } else if (msgType === 'event') {
      const telegramMsg = `📩 <b>企业微信事件</b>\n\n👤 用户: <code>${fromUser}</code>\n📌 事件: ${event}\n⏰ 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      await sendToTelegram(telegramMsg);

      if (event === 'subscribe') {
        setUserSession(fromUser, { type: 'main_menu' });
        await sendWeComMessage(fromUser, `👋 欢迎使用教学管理助手！\n\n${getMainMenuText()}`);
      }
    }

    res.send('success');
  } catch (error) {
    console.error('处理消息异常:', error);
    res.send('success');
  }
});

app.post('/api/wecom/send', async (req, res) => {
  try {
    const { touser, content } = req.body;
    const result = await sendWeComMessage(touser || '@all', content);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// HTTP API: 获取外部群列表
app.get('/api/customer-groups', async (req, res) => {
  try {
    const result = await getCustomerGroups();
    if (result.success) {
      res.json({ code: 0, data: result.groups });
    } else {
      res.json({ code: -1, message: result.error });
    }
  } catch (error) {
    res.status(500).json({ code: -1, message: error.message });
  }
});

// HTTP API: 获取指定群的二维码
app.get('/api/customer-groups/:chatId/qrcode', async (req, res) => {
  try {
    const { chatId } = req.params;
    const result = await getGroupQrcode(chatId);
    if (result.success) {
      res.json({ code: 0, data: { qrcodeUrl: result.qrcodeUrl } });
    } else {
      res.json({ code: -1, message: result.error });
    }
  } catch (error) {
    res.status(500).json({ code: -1, message: error.message });
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
    features: ['telegram_forward', 'auto_reply', 'homework_sync', 'homework_reminder', 'customer_groups']
  });
});

app.get('/', (req, res) => {
  res.json({
    name: '英语培训系统 - 企业微信服务',
    status: 'running',
    features: ['消息转发到Telegram', '自动回复', '作业同步', '作业提醒'],
    endpoints: {
      callback: '/api/wecom/callback',
      send: '/api/wecom/send',
      health: '/health'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('==========================================');
  console.log('  英语培训系统 - 企业微信服务 v5.0');
  console.log('==========================================');
  console.log(`🚀 服务启动成功，端口: ${PORT}`);
  console.log(`📍 回调地址: http://101.32.253.147/api/wecom/callback`);
  console.log(`📱 Telegram 转发: ${TELEGRAM_CHAT_ID || '未配置'}`);
  console.log(`🤖 自动回复: 已启用`);
  console.log(`📚 作业同步: 已启用`);
  console.log(`⏰ 作业提醒: 已启用 (18:00, 20:00)`);
  console.log(`🔧 配置状态: ${hasConfig ? '✅ 完整' : '⚠️ 不完整'}`);
  console.log('==========================================');
  
  initSchedules();
});
