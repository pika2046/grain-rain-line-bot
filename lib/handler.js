// 訊息處理：會話狀態＋訂單狀態機＋LINE reply＋客人檔案
const { chat } = require('./llm');
const db = require('./customer-db');

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const BOSS_USER_ID = process.env.BOSS_USER_ID; // 老闆私人 LINE 的 userId（U 開頭），有設才推播

// 會話記憶（每位用戶：對話歷史＋訂單狀態）
// 注意：正式上線建議改用 Redis／資料庫，記憶體版重啟會遺失。
const sessions = new Map();
const MAX_HISTORY = 20; // 只保留最近 20 則，避免 token 爆掉

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { history: [], order: null });
    console.log('[new user]', userId); // 抓 userId 用（老闆 BOSS_USER_ID 設定）
  }
  return sessions.get(userId);
}

async function lineReply(replyToken, texts) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: texts.slice(0, 5).map((t) => ({ type: 'text', text: t })),
    }),
  });
  if (!res.ok) throw new Error(`LINE reply ${res.status}: ${await res.text()}`);
}

async function linePush(to, texts) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to,
      messages: texts.slice(0, 5).map((t) => ({ type: 'text', text: t })),
    }),
  });
  if (!res.ok) throw new Error(`LINE push ${res.status}: ${await res.text()}`);
}

function orderSummary(order) {
  const lines = (order.items || []).map((i) => `・${i.name} x${i.qty}`);
  return [
    '跟你確認一下訂單：',
    ...lines,
    `取餐時間：${order.pickup_time || '未填'}`,
    `姓名：${order.name || '未填'}　電話：${order.phone || '未填'}`,
    '沒問題請回「確認」，要改直接跟我說！',
  ].join('\n');
}

// 簡稱→正式品項（跟知識庫的簡稱對照表同步）
const ALIAS = {
  '雞胸': '厚切舒肥嫩雞胸', '舒肥雞': '厚切舒肥嫩雞胸',
  '梅花豬': '韓式醬烤梅花豬', '韓式烤梅花': '韓式醬烤梅花豬',
  '打拋豬': '泰式酸辣打拋豬', '泰式打拋豬': '泰式酸辣打拋豬', '泰式打拋': '泰式酸辣打拋豬', '打拋': '泰式酸辣打拋豬',
  '虱目魚': '嫩煎台南虱目魚柳', '魚柳': '嫩煎台南虱目魚柳', '魚': '嫩煎台南虱目魚柳',
  '壽喜牛': '和風壽喜牛丼', '牛肉丼': '和風壽喜牛丼', '牛丼': '和風壽喜牛丼',
  '雙拼': '120%元氣雙拼', '雙拼餐盒': '120%元氣雙拼',
  '爌肉': '作弊日一號 阿嬤爌肉＋滷雞腿', '滷雞腿': '作弊日一號 阿嬤爌肉＋滷雞腿',
  '三倍牛': '作弊日二號 三倍壽喜牛丼',
};
const SURNAMES = '王李張劉陳楊黃趙吳周徐孫馬朱胡郭何羅梁鄭謝宋唐鄧韓馮董蕭程曹袁許傅沈曾彭呂蘇盧蔣蔡賈丁魏薛葉閻余潘杜戴夏鍾汪田任姜范方石姚譚廖鄒熊金陸郝孔白崔康毛邱秦江史顧侯邵孟龍萬段雷錢湯尹黎易常武喬賀賴龔文';
const CN_NUM = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function toQty(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (CN_NUM[s] !== undefined) return CN_NUM[s];
  return 0;
}

// LLM 格式跑掉時的最後救援：用正規表示式從訊息抓姓名、電話、外送地址、品項
function salvage(text) {
  const out = { name: null, phone: null, address: null, items: [] };
  const phoneM = text.match(/09\d{8}/);
  if (phoneM) out.phone = phoneM[0];
  const nameM = text.match(/訂購人[：:\s]*([^\s，,。；;]+)/)
    || text.match(new RegExp(`([${SURNAMES}][^\\s，,。；;]{0,3})(先生|小姐|太太|老闆)`));
  if (nameM) out.name = nameM[1] + (nameM[2] || '');
  const addrM = text.match(/(?:外送到|送到|地址[：:\s]*)([^\n，。；;]+)/);
  if (addrM) out.address = addrM[1].trim();
  const aliases = Object.keys(ALIAS).sort((a, b) => b.length - a.length);
  const itemRe = /([0-9一二兩三四五六七八九十]+)\s*個?\s*([^\d\s，,。；;]+)/g;
  let m;
  while ((m = itemRe.exec(text)) !== null) {
    const qty = toQty(m[1]);
    if (!(qty > 0 && qty < 1000)) continue;
    const raw = m[2];
    // 單字簡稱（如「魚」）只接受完全相符，避免誤判
    const hit = aliases.find((a) => (a.length >= 2 && raw.includes(a)) || (a.length === 1 && raw === a));
    if (hit) out.items.push({ name: ALIAS[hit], qty });
  }
  return out;
}

// LLM 格式跑掉時的救援：把抓到的資訊併入訂單，盡量完成流程
function salvageResult(text, order) {
  const s = salvage(text);
  const hasInfo = s.name || s.phone || s.address || s.items.length;
  if (order && hasInfo) {
    if (s.items.length) order.items = s.items;
    if (s.name) order.name = s.name;
    if (s.phone) order.phone = s.phone;
    if (s.address) order.address = s.address;
    if (order.name && order.phone) {
      const addrLine = order.address ? `，外送到${order.address}` : '';
      return {
        reply: `好的，${order.name}！電話 ${order.phone}${addrLine}都記下了。訂單成立，我們會妥善安排，謝謝您的訂購！`,
        order: { ...order, status: 'confirmed' },
        customer_note: null,
      };
    }
    const missing = [];
    if (!order.name) missing.push('稱呼');
    if (!order.phone) missing.push('電話');
    const got = [];
    if (s.items.length) got.push(s.items.map((i) => `${i.name}${i.qty}個`).join('、'));
    if (s.name) got.push(s.name);
    if (s.phone) got.push(`電話 ${s.phone}`);
    if (s.address) got.push(`外送到${s.address}`);
    return {
      reply: `好的，${got.join('、')}記下了。再麻煩提供${missing.join('和')}，我們好為您完成預訂，謝謝！`,
      order: { ...order, status: 'collecting' },
      customer_note: null,
    };
  }
  return { reply: '不好意思，我剛剛沒聽清楚，可以再說一次嗎？', order: null, customer_note: null };
}

async function handleMessage(event) {
  const userId = event.source.userId;
  const text = (event.message.text || '').trim();
  if (!text) return;

  const session = getSession(userId);
  session.history.push({ role: 'user', content: text });
  session.history = session.history.slice(-MAX_HISTORY);

  // 老客人：把檔案摘要塞給 LLM，讓艾琳認得人
  let profileLine = '';
  try {
    const p = await db.getProfile(userId);
    if (p && (p.name || p.orderCount !== '0')) {
      profileLine = `【老客人檔案】${p.name ? p.name : '（未留名）'}，來過 ${p.orderCount} 次${p.lastOrder ? `，上次點了：${p.lastOrder}` : ''}${p.note ? `，喜好/忌口：${p.note}` : ''}。自然地認出他（例：「還是跟上次一樣嗎？」），不要生硬背誦。`;
    }
  } catch (e) {
    console.error('[profile]', e.message);
  }

  let result;
  try {
    result = await chat(session.history, profileLine);
  } catch (e) {
    console.error('[llm]', e.message);
    await lineReply(event.replyToken, ['不好意思，系統剛剛恍神了一下，可以再說一次嗎？']);
    session.history.pop();
    return;
  }

  // LLM 兩次格式都跑掉：用正規表示式救援，盡量把訂單完成，不跟客人說沒聽清楚
  if (result.parseFailed) {
    console.error('[salvage] regex rescue for:', text.slice(0, 60));
    result = salvageResult(text, session.order);
  }

  const replyText = result.reply || '收到！';
  session.history.push({ role: 'assistant', content: replyText });

  const order = result.order;
  session.order = order && order.status !== 'none' ? order : null;

  // 訂單剛被確認：寫入客人檔案＋推播通知老闆（每單扣 1 則額度）
  if (order && order.status === 'confirmed') {
    console.log('[ORDER CONFIRMED]', JSON.stringify({ userId, ...order }));
    await db.saveOrder({ userId, name: order.name, phone: order.phone, items: order.items, pickup_time: order.pickup_time });
    if (BOSS_USER_ID) {
      const lines = (order.items || []).map((i) => `・${i.name} x${i.qty}`).join('\n');
      const msg = [
        '【新訂單】',
        lines,
        `取餐時間：${order.pickup_time || '未填'}`,
        `姓名：${order.name || '未填'}　電話：${order.phone || '未填'}`,
        ...(order.address ? [`外送地址：${order.address}`] : []),
      ].join('\n');
      try {
        await linePush(BOSS_USER_ID, [msg]);
      } catch (e) {
        console.error('[push boss]', e.message);
      }
    }
    session.order = null; // 結單後重置，下一筆重新開始
  }

  // LLM 順手記下的客人偏好 → 寫入檔案
  if (result.customer_note) {
    await db.updateNote(userId, result.customer_note);
  }

  await lineReply(event.replyToken, [replyText]);
}

module.exports = { handleMessage, orderSummary };
