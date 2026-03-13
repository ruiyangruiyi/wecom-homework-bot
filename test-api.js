require('dotenv').config();
const axios = require('axios');

const CORP_ID = process.env.WECOM_CORP_ID;
const SECRET = process.env.WECOM_SECRET;

async function test() {
  console.log('=== 企业微信 API 权限测试 ===\n');
  console.log('Corp ID:', CORP_ID);
  console.log('Secret:', SECRET ? SECRET.slice(0, 6) + '...' : '未配置');
  
  if (!CORP_ID || !SECRET) {
    console.log('\n❌ 缺少配置，请检查 .env 文件');
    return;
  }

  try {
    // 1. 获取 access_token
    console.log('\n1. 获取 access_token...');
    const tokenRes = await axios.get('https://qyapi.weixin.qq.com/cgi-bin/gettoken', {
      params: { corpid: CORP_ID, corpsecret: SECRET }
    });
    
    if (tokenRes.data.errcode !== 0) {
      console.log('❌ 获取 token 失败:', tokenRes.data);
      return;
    }
    
    const token = tokenRes.data.access_token;
    console.log('✅ Token 获取成功');

    // 2. 测试客户群列表 API
    console.log('\n2. 测试客户群列表 API...');
    const groupRes = await axios.post(
      `https://qyapi.weixin.qq.com/cgi-bin/externalcontact/groupchat/list?access_token=${token}`,
      {
        status_filter: 0,
        limit: 10
      }
    );
    
    console.log('响应:', JSON.stringify(groupRes.data, null, 2));
    
    if (groupRes.data.errcode === 0) {
      console.log('\n✅ API 调用成功！权限配置正确');
      console.log('群数量:', groupRes.data.group_chat_list?.length || 0);
    } else {
      console.log('\n❌ API 调用失败');
      console.log('错误码:', groupRes.data.errcode);
      console.log('错误信息:', groupRes.data.errmsg);
    }

  } catch (error) {
    console.log('❌ 请求异常:', error.message);
  }
}

test();
