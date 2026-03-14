/**
 * 作业 CRUD API 模块
 */

const { redis, parseHomeworkDetails } = require('./homework-sync');

// 创建作业
async function createHomework(data) {
  const { title, content, classId, deadline, createdBy } = data;
  
  if (!title || !content) {
    return { success: false, error: '标题和内容不能为空' };
  }

  const homeworkId = `hw:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date();
  
  const homeworkData = {
    id: homeworkId,
    title,
    content,
    classId: classId || 'default',
    deadline: deadline || null,
    createdBy: createdBy || 'system',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: 'active'
  };

  await redis.hset(`homework:${homeworkId}`, homeworkData);
  await redis.zadd('homeworks:all', now.getTime(), homeworkId);
  
  if (classId) {
    await redis.zadd(`class:${classId}:homeworks`, now.getTime(), homeworkId);
  }

  return { success: true, data: homeworkData };
}

// 获取作业详情
async function getHomework(homeworkId) {
  const data = await redis.hgetall(`homework:${homeworkId}`);
  
  if (!data || !data.id) {
    return { success: false, error: '作业不存在' };
  }

  return { success: true, data };
}

// 获取作业列表
async function listHomeworks(options = {}) {
  const { classId, status, page = 1, pageSize = 20 } = options;
  
  let key = 'homeworks:all';
  if (classId) {
    key = `class:${classId}:homeworks`;
  }

  const start = (page - 1) * pageSize;
  const end = start + pageSize - 1;
  
  const homeworkIds = await redis.zrevrange(key, start, end);
  const total = await redis.zcard(key);
  
  const homeworks = [];
  for (const id of homeworkIds) {
    const data = await redis.hgetall(`homework:${id}`);
    if (data && data.id) {
      if (!status || data.status === status) {
        homeworks.push(data);
      }
    }
  }

  return {
    success: true,
    data: homeworks,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize)
    }
  };
}

// 更新作业
async function updateHomework(homeworkId, updates) {
  const existing = await redis.hgetall(`homework:${homeworkId}`);
  
  if (!existing || !existing.id) {
    return { success: false, error: '作业不存在' };
  }

  const allowedFields = ['title', 'content', 'deadline', 'status'];
  const updateData = { updatedAt: new Date().toISOString() };
  
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      updateData[field] = updates[field];
    }
  }

  await redis.hset(`homework:${homeworkId}`, updateData);
  
  const updated = await redis.hgetall(`homework:${homeworkId}`);
  return { success: true, data: updated };
}

// 删除作业（软删除）
async function deleteHomework(homeworkId) {
  const existing = await redis.hgetall(`homework:${homeworkId}`);
  
  if (!existing || !existing.id) {
    return { success: false, error: '作业不存在' };
  }

  await redis.hset(`homework:${homeworkId}`, {
    status: 'deleted',
    deletedAt: new Date().toISOString()
  });

  return { success: true, message: '作业已删除' };
}

// Express 路由注册
function registerHomeworkRoutes(app) {
  // 创建作业
  app.post('/api/homework', async (req, res) => {
    try {
      const result = await createHomework(req.body);
      res.status(result.success ? 201 : 400).json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 获取作业列表
  app.get('/api/homework', async (req, res) => {
    try {
      const { classId, status, page, pageSize } = req.query;
      const result = await listHomeworks({
        classId,
        status,
        page: parseInt(page) || 1,
        pageSize: parseInt(pageSize) || 20
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 获取作业详情
  app.get('/api/homework/:id', async (req, res) => {
    try {
      const result = await getHomework(req.params.id);
      res.status(result.success ? 200 : 404).json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 更新作业
  app.put('/api/homework/:id', async (req, res) => {
    try {
      const result = await updateHomework(req.params.id, req.body);
      res.status(result.success ? 200 : 404).json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 删除作业
  app.delete('/api/homework/:id', async (req, res) => {
    try {
      const result = await deleteHomework(req.params.id);
      res.status(result.success ? 200 : 404).json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

module.exports = {
  createHomework,
  getHomework,
  listHomeworks,
  updateHomework,
  deleteHomework,
  registerHomeworkRoutes
};
