/**
 * 作业同步模块
 */

const Redis = require('ioredis');

const redis = new Redis({
  host: '127.0.0.1',
  port: 6379,
  retryStrategy: (times) => Math.min(times * 50, 2000)
});

const HOMEWORK_PATTERNS = [
  // 原有模式
  /【作业】(.+)/s,
  /#作业\s*(.+)/s,
  /今日作业[：:]\s*(.+)/s,
  /作业布置[：:]\s*(.+)/s,
  /布置作业\s*(.+)/s,
  /homework[：:]\s*(.+)/is,
  // 新增模式：「作业：」「作业 」开头
  /^作业[：:]\s*(.+)/s,
  /^作业\s+(.+)/s,
];

// 日期格式检测（如 2026.3.8、2026-03-08、3月8日）
const DATE_PATTERNS = [
  /\d{4}\.\d{1,2}\.\d{1,2}/,  // 2026.3.8
  /\d{4}-\d{1,2}-\d{1,2}/,    // 2026-03-08
  /\d{1,2}月\d{1,2}[日号]/,   // 3月8日
];

function detectHomework(content) {
  if (!content || typeof content !== 'string') return null;
  
  // 先检查标准作业模式
  for (const pattern of HOMEWORK_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      return {
        raw: content,
        content: match[1].trim(),
        pattern: pattern.source,
        type: 'pattern'
      };
    }
  }
  
  // 检查是否包含日期 + 作业关键词
  const hasDate = DATE_PATTERNS.some(p => p.test(content));
  const hasHomeworkKeyword = /作业|homework/i.test(content);
  if (hasDate && hasHomeworkKeyword) {
    return {
      raw: content,
      content: content,
      pattern: 'date+keyword',
      type: 'inferred'
    };
  }
  
  return null;
}

function parseHomeworkDetails(homeworkContent) {
  const details = {
    title: '',
    items: [],
    deadline: null,
    subject: null
  };

  const deadlineMatch = homeworkContent.match(/截止[：:时间]*\s*([^\n]+)/);
  if (deadlineMatch) {
    details.deadline = deadlineMatch[1].trim();
  }

  const subjectMatch = homeworkContent.match(/(英语|数学|语文|物理|化学|生物|历史|地理|政治)/);
  if (subjectMatch) {
    details.subject = subjectMatch[1];
  }

  const lines = homeworkContent.split(/[\n\r]+/).filter(line => line.trim());
  
  if (lines.length > 0) {
    details.title = lines[0].replace(/^[\d\.\、\-\*]+\s*/, '').trim();
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !line.match(/^截止/)) {
        details.items.push({
          index: i + 1,
          content: line
        });
      }
    }
  }

  return details;
}

async function saveHomework(homework, chatId, fromUser) {
  const homeworkId = `hw:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date();
  
  const homeworkData = {
    id: homeworkId,
    chatId,
    fromUser,
    raw: homework.raw,
    content: homework.content,
    details: JSON.stringify(parseHomeworkDetails(homework.content)),
    createdAt: now.toISOString(),
    status: 'active'
  };

  await redis.hset(`homework:${homeworkId}`, homeworkData);
  await redis.zadd(`chat:${chatId}:homeworks`, now.getTime(), homeworkId);
  await redis.zadd('homeworks:all', now.getTime(), homeworkId);

  console.log(`✅ 作业已保存: ${homeworkId}`);
  return homeworkId;
}

async function getRecentHomeworks(chatId, limit = 10) {
  const homeworkIds = await redis.zrevrange(`chat:${chatId}:homeworks`, 0, limit - 1);
  const homeworks = [];
  
  for (const id of homeworkIds) {
    const data = await redis.hgetall(`homework:${id}`);
    if (data && data.id) {
      data.details = JSON.parse(data.details || '{}');
      homeworks.push(data);
    }
  }
  
  return homeworks;
}

module.exports = {
  detectHomework,
  parseHomeworkDetails,
  saveHomework,
  getRecentHomeworks,
  redis
};
