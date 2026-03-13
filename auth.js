/**
 * 认证模块
 * - 用户数据存储在 Redis
 * - JWT token 认证
 * - 密码使用 bcrypt 加密
 */

const crypto = require('crypto');
const Redis = require('ioredis');

const redis = new Redis({
  host: '127.0.0.1',
  port: 6379,
  retryStrategy: (times) => Math.min(times * 50, 2000)
});

// JWT 配置
const JWT_SECRET = process.env.JWT_SECRET || 'twinsun-edu-secret-key-2026';
const JWT_EXPIRES_IN = 24 * 60 * 60 * 1000; // 24小时

// 简单的 JWT 实现（不依赖外部库）
function base64UrlEncode(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString();
}

function createToken(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Date.now();
  const tokenPayload = {
    ...payload,
    iat: now,
    exp: now + JWT_EXPIRES_IN
  };
  
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(tokenPayload));
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  
  return `${headerB64}.${payloadB64}.${signature}`;
}

function verifyToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [headerB64, payloadB64, signature] = parts;
    
    // 验证签名
    const expectedSig = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    
    if (signature !== expectedSig) return null;
    
    // 解析 payload
    const payload = JSON.parse(base64UrlDecode(payloadB64));
    
    // 检查过期
    if (payload.exp && Date.now() > payload.exp) return null;
    
    return payload;
  } catch (e) {
    return null;
  }
}

// 密码哈希（使用 crypto，不依赖 bcrypt）
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const verifyHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

// 用户管理
async function createUser(username, password, role = 'user', name = '') {
  const userId = `user:${username}`;
  const exists = await redis.exists(userId);
  if (exists) {
    return { success: false, error: '用户已存在' };
  }
  
  const hashedPassword = hashPassword(password);
  const user = {
    username,
    password: hashedPassword,
    role,
    name: name || username,
    createdAt: new Date().toISOString()
  };
  
  await redis.hset(userId, user);
  await redis.sadd('users:all', username);
  
  console.log(`✅ 用户创建成功: ${username}`);
  return { success: true, username };
}

async function getUser(username) {
  const userId = `user:${username}`;
  const user = await redis.hgetall(userId);
  if (!user || !user.username) return null;
  return user;
}

async function login(username, password) {
  const user = await getUser(username);
  if (!user) {
    return { success: false, error: '用户不存在' };
  }
  
  if (!verifyPassword(password, user.password)) {
    return { success: false, error: '密码错误' };
  }
  
  const token = createToken({
    username: user.username,
    role: user.role,
    name: user.name
  });
  
  // 记录登录时间
  await redis.hset(`user:${username}`, 'lastLogin', new Date().toISOString());
  
  return {
    success: true,
    token,
    user: {
      username: user.username,
      role: user.role,
      name: user.name
    }
  };
}

// 初始化演示账号
async function initDemoUsers() {
  const demoUsers = [
    { username: 'admin', password: 'admin123', role: 'admin', name: '管理员' },
    { username: 'teacher', password: 'teacher123', role: 'teacher', name: '张老师' }
  ];
  
  for (const user of demoUsers) {
    const exists = await redis.exists(`user:${user.username}`);
    if (!exists) {
      await createUser(user.username, user.password, user.role, user.name);
    }
  }
  
  console.log('✅ 演示账号初始化完成');
}

// Express 中间件
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: '未提供认证令牌' });
  }
  
  const token = authHeader.substring(7);
  const payload = verifyToken(token);
  
  if (!payload) {
    return res.status(401).json({ success: false, error: '令牌无效或已过期' });
  }
  
  req.user = payload;
  next();
}

// 角色检查中间件
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: '未认证' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: '权限不足' });
    }
    next();
  };
}

module.exports = {
  createUser,
  getUser,
  login,
  initDemoUsers,
  authMiddleware,
  requireRole,
  verifyToken,
  createToken
};
