/**
 * 作业提醒模块
 * 功能：每日定时提醒学生完成作业
 */

require('dotenv').config();
const cron = require('node-cron');
const axios = require('axios');
const { getRecentHomeworks, redis } = require('./homework-sync');

// 企业微信配置（从环境变量读取）
const CORP_ID = process.env.WECOM_CORP_ID;
const AGENT_ID = process.env.WECOM_AGENT_ID;
const SECRET = process.env.WECOM_SECRET;

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

async function sendWeComMessage(toUser, content) {
  const token = await getAccessToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
  const response = await axios.post(url, {
    touser: toUser,
    msgtype: 'text',
    agentid: AGENT_ID,
    text: { content }
  });
  return response.data;
}

// 正能量文案库
const POSITIVE_MESSAGES = [
  '🌟 亲爱的同学，今天的作业完成了吗？坚持就是胜利，加油！',
  '💪 同学们，作业是巩固知识的最好方式。让我们一起努力吧！',
  '🎯 每一次认真完成作业，都是向成功迈进的一步。你可以的！',
  '✨ 作业虽然有时候很累，但完成它会让你更加优秀。加油！',
  '🚀 今天的作业，明天的成就。让我们一起加油吧！',
  '📚 知识改变命运，作业成就梦想。坚持完成每一份作业！',
  '🌈 每一份认真的作业，都是对自己的投资。加油，同学！',
  '💎 优秀的人都在坚持完成作业，你也可以成为其中一员！',
];

/**
 * 获取随机正能量文案
 */
function getPositiveMessage() {
  return POSITIVE_MESSAGES[Math.floor(Math.random() * POSITIVE_MESSAGES.length)];
}

/**
 * 发送作业提醒
 * @param {string} chatId 群ID
 * @param {string} toUser 接收者
 */
async function sendHomeworkReminder(chatId, toUser) {
  try {
    const homeworks = await getRecentHomeworks(chatId, 5);
    
    if (homeworks.length === 0) {
      return;
    }

    let message = getPositiveMessage() + '\n\n📋 待完成作业：\n';
    
    for (let i = 0; i < homeworks.length; i++) {
      const hw = homeworks[i];
      const details = hw.details;
      message += `\n${i + 1}. ${details.title || '作业' + (i + 1)}\n`;
      if (details.deadline) {
        message += `   ⏰ 截止: ${details.deadline}\n`;
      }
      if (details.items && details.items.length > 0) {
        message += `   📝 ${details.items.length} 项任务\n`;
      }
    }

    message += '\n\n💬 如有问题，请随时提问。祝你学习愉快！';

    await sendWeComMessage(toUser, message);
    console.log(`✅ 作业提醒已发送给 ${toUser}`);
  } catch (error) {
    console.error('❌ 发送作业提醒失败:', error.message);
  }
}

/**
 * 初始化定时任务
 * 每天 18:00 和 20:00 发送提醒
 */
function initSchedules() {
  // 每天 18:00 发送提醒
  cron.schedule('0 18 * * *', async () => {
    console.log('📚 触发作业提醒任务 (18:00)');
    try {
      // 获取所有群
      const chatIds = await redis.keys('chat:*:homeworks');
      for (const key of chatIds) {
        const chatId = key.replace('chat:', '').replace(':homeworks', '');
        // 这里应该获取群内所有学生，暂时发送给管理员
        await sendHomeworkReminder(chatId, '@all');
      }
    } catch (error) {
      console.error('❌ 作业提醒任务失败:', error.message);
    }
  });

  // 每天 20:00 发送最后提醒
  cron.schedule('0 20 * * *', async () => {
    console.log('📚 触发作业提醒任务 (20:00)');
    try {
      const chatIds = await redis.keys('chat:*:homeworks');
      for (const key of chatIds) {
        const chatId = key.replace('chat:', '').replace(':homeworks', '');
        const message = '⏰ 亲爱的同学们，作业截止时间即将到来，请抓紧时间完成！\n\n💪 坚持就是胜利，加油！';
        await sendWeComMessage('@all', message);
      }
    } catch (error) {
      console.error('❌ 最后提醒任务失败:', error.message);
    }
  });

  console.log('✅ 作业提醒定时任务已初始化');
}

module.exports = {
  sendHomeworkReminder,
  initSchedules,
  getPositiveMessage
};
