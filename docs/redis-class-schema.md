# Redis 数据结构设计 - 班级模型

## 班级表 (class)

### 存储结构
```
Hash: class:{classId}
```

### 字段
| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 班级ID（UUID） |
| name | string | 班级名称（如：初三英语A班） |
| groupId | string | 绑定的群ID（可为空） |
| groupName | string | 绑定的群名称（冗余，方便查询） |
| ownerId | string | 班主任/创建者 userId |
| ownerName | string | 班主任名称 |
| status | string | 状态：active/archived |
| createdAt | string | 创建时间 ISO8601 |
| updatedAt | string | 更新时间 ISO8601 |

### 索引
```
Set: classes:all                    # 所有班级ID
Set: classes:owner:{ownerId}        # 某老师的所有班级
Hash: class:group:{groupId}         # 群ID -> 班级ID 映射（快速查找）
```

### 示例
```redis
HSET class:cls_abc123 id "cls_abc123" name "初三英语A班" groupId "wrNplDCwAAxxxxxx" ownerId "ZhangChong" status "active" createdAt "2026-03-13T18:00:00+08:00"
SADD classes:all "cls_abc123"
SADD classes:owner:ZhangChong "cls_abc123"
HSET class:group:wrNplDCwAAxxxxxx classId "cls_abc123"
```

---

## 班级成员表 (class_member)

### 存储结构
```
Hash: class:{classId}:member:{oderId}
Set: class:{classId}:members         # 成员ID列表
```

### 字段
| 字段 | 类型 | 说明 |
|------|------|------|
| oderId | string | 成员ID（企业微信 external_userid 或 userid） |
| classId | string | 所属班级ID |
| role | string | 角色：teacher/student/parent |
| name | string | 成员名称 |
| joinedAt | string | 加入时间 ISO8601 |
| status | string | 状态：active/left |

### 索引
```
Set: member:{userId}:classes         # 某成员加入的所有班级
```

### 示例
```redis
HSET class:cls_abc123:member:wmxxxxxx userId "wmxxxxxx" classId "cls_abc123" role "student" name "张三" joinedAt "2026-03-13T18:00:00+08:00" status "active"
SADD class:cls_abc123:members "wmxxxxxx"
SADD member:wmxxxxxx:classes "cls_abc123"
```

---

## 作业表扩展

### 变更
原：`homework:{homeworkId}` 的 `chatId` 字段
新：增加 `classId` 字段，`chatId` 改为 `groupId`

### 字段
| 字段 | 类型 | 说明 |
|------|------|------|
| classId | string | 所属班级ID |
| groupId | string | 发布到的群ID（可能与班级绑定群不同） |

### 索引
```
ZSet: class:{classId}:homeworks      # 班级的所有作业（按时间排序）
```

---

## 操作示例

### 创建班级
```javascript
async function createClass(name, ownerId, ownerName) {
  const classId = `cls_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date().toISOString();
  
  await redis.hset(`class:${classId}`, {
    id: classId,
    name,
    groupId: '',
    groupName: '',
    ownerId,
    ownerName,
    status: 'active',
    createdAt: now,
    updatedAt: now
  });
  
  await redis.sadd('classes:all', classId);
  await redis.sadd(`classes:owner:${ownerId}`, classId);
  
  return classId;
}
```

### 绑定群
```javascript
async function bindGroup(classId, groupId, groupName) {
  // 检查群是否已被其他班级绑定
  const existing = await redis.hget(`class:group:${groupId}`, 'classId');
  if (existing && existing !== classId) {
    throw new Error('该群已绑定其他班级');
  }
  
  // 解绑旧群
  const oldGroupId = await redis.hget(`class:${classId}`, 'groupId');
  if (oldGroupId) {
    await redis.del(`class:group:${oldGroupId}`);
  }
  
  // 绑定新群
  await redis.hset(`class:${classId}`, {
    groupId,
    groupName,
    updatedAt: new Date().toISOString()
  });
  await redis.hset(`class:group:${groupId}`, 'classId', classId);
}
```

### 添加成员
```javascript
async function addMember(classId, userId, name, role = 'student') {
  const now = new Date().toISOString();
  
  await redis.hset(`class:${classId}:member:${userId}`, {
    userId,
    classId,
    role,
    name,
    joinedAt: now,
    status: 'active'
  });
  
  await redis.sadd(`class:${classId}:members`, userId);
  await redis.sadd(`member:${userId}:classes`, classId);
}
```

### 获取班级成员
```javascript
async function getClassMembers(classId) {
  const memberIds = await redis.smembers(`class:${classId}:members`);
  const members = [];
  
  for (const id of memberIds) {
    const member = await redis.hgetall(`class:${classId}:member:${id}`);
    if (member && member.status === 'active') {
      members.push(member);
    }
  }
  
  return members;
}
```

---

## 查询场景

| 场景 | 命令 |
|------|------|
| 获取所有班级 | `SMEMBERS classes:all` |
| 获取老师的班级 | `SMEMBERS classes:owner:{ownerId}` |
| 通过群ID找班级 | `HGET class:group:{groupId} classId` |
| 获取班级成员 | `SMEMBERS class:{classId}:members` |
| 获取班级作业 | `ZREVRANGE class:{classId}:homeworks 0 -1` |
| 获取成员加入的班级 | `SMEMBERS member:{userId}:classes` |
