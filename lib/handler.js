// 訊息處理：會話狀態＋訂單狀態機＋LINE reply＋客人檔案
const { chat } = require('./llm');
const db = require('./customer-db');

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const BOSS_USER_ID = process.env.BOSS_USER_ID; // 老闆私人 LINE 的 userId（U 開頭），有設才推播

// 會話記憶：改由試算表持久化（lib/customer-db.js），重啟/部署不再遺失
const MAX_HISTORY = 20; // 只保留最近 20 則，避免 token 爆掉

// 老闆手動接管：暫停自動回覆（重啟後預設恢復，避免忘記開回來）
let manualPaused = false; // 全部暫停
let pauseUntil = 0;
const pausedUsers = new Map(); // 單一客人暫停：userId → 到期時間戳
let lastCustomer = null; // 最近一位客人的 userId（不含老闆本人）

// 確認 pattern：短訊息以確認詞開頭、且不含否定詞，才算成立
function isConfirmText(text) {
  const t = text.trim();
  if (t.length > 12) return false;
  return /^(確認|好|好的|可以|沒問題|OK|ok|對|確定|就這樣)/.test(t) && !/(不要|不行|取消|改|等一下)/.test(t);
}

// 解析取餐時間是星期幾（0=週日..6=週六），無法判斷回 null
function parseDayOfWeek(pickupTime) {
  if (!pickupTime) return null;
  const now = new Date();
  if (/大後天/.test(pickupTime)) { const d = new Date(now); d.setDate(d.getDate() + 3); return d.getDay(); }
  if (/後天/.test(pickupTime)) { const d = new Date(now); d.setDate(d.getDate() + 2); return d.getDay(); }
  if (/明天/.test(pickupTime)) { const d = new Date(now); d.setDate(d.getDate() + 1); return d.getDay(); }
  const weekM = pickupTime.match(/週([一二三四五六日天])/);
  if (weekM) return { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }[weekM[1]];
  const mdM = pickupTime.match(/(\d{1,2})\/(\d{1,2})/) || pickupTime.match(/(\d{1,2})月(\d{1,2})[日號]/);
  if (mdM) {
    const d = new Date(now.getFullYear(), parseInt(mdM[1], 10) - 1, parseInt(mdM[2], 10));
    if (d.getTime() < now.getTime() - 86400000 * 30) d.setFullYear(d.getFullYear() + 1);
    return d.getDay();
  }
  return null;
}

// 作弊日檢查：作弊餐只有週五、週六供應，其他時間直接擋下
function checkCheatDay(items, pickupTime) {
  const hasCheat = (items || []).some((i) => (i.name || '').includes('作弊日'));
  if (!hasCheat) return null;
  const day = parseDayOfWeek(pickupTime);
  if (day !== null && day !== 5 && day !== 6) {
    return '不好意思，作弊日餐點只有週五、週六才有供應喔！您選的時間沒有，要不要改成其他餐點，或改週五／六取餐呢？';
  }
  return null;
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
  const lines = (order.items || []).map((i) => `・${i.name} x${i.qty}${i.note ? `（${i.note}）` : ''}`);
  return [
    '跟你確認一下訂單：',
    ...lines,
    `取餐時間：${order.pickup_time || '未填'}`,
    `姓名：${order.name || '未填'}　電話：${order.phone || '未填'}`,
    ...(order.address ? [`外送地址：${order.address}`] : []),
    ...(order.generalNote ? [`備註：${order.generalNote}`] : []),
    '沒問題請回「確認」，要改直接跟我說！',
  ].join('\n');
}

// 簡稱→正式品項（跟知識庫的簡稱對照表同步）
const ALIAS = {
  '雞胸': '厚切舒肥嫩雞胸', '舒肥雞': '厚切舒肥嫩雞胸',
  '梅花豬': '韓式醬烤梅花豬', '韓式烤梅花': '韓式醬烤梅花豬',
  '打拋豬': '泰式打拋豬', '泰式打拋豬': '泰式打拋豬', '泰式打拋': '泰式打拋豬', '打拋': '泰式打拋豬',
  '虱目魚': '嫩煎台南虱目魚柳', '魚柳': '嫩煎台南虱目魚柳', '魚': '嫩煎台南虱目魚柳',
  '壽喜牛': '和風壽喜牛丼', '牛肉丼': '和風壽喜牛丼', '牛丼': '和風壽喜牛丼',
  '雙拼': '120%元氣雙拼', '雙拼餐盒': '120%元氣雙拼',
  '爌肉': '作弊日一號 阿嬤爌肉＋滷雞腿', '滷雞腿': '作弊日一號 阿嬤爌肉＋滷雞腿', '控肉': '作弊日一號 阿嬤爌肉＋滷雞腿', '控肉飯': '作弊日一號 阿嬤爌肉＋滷雞腿', '爌肉飯': '作弊日一號 阿嬤爌肉＋滷雞腿',
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
  if (addrM) {
    out.address = addrM[1].trim();
  } else {
    // 沒有關鍵字時：如果某一行像地址（有路/街/號/中心/大樓等）就當地址
    const lines = text.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (t && !/09\d{8}/.test(t) && !new RegExp(`^[${SURNAMES}]`).test(t) &&
          /(路|街|號|中心|大樓|廣場|園區|醫院|學校|公司)/.test(t)) {
        out.address = t;
        break;
      }
    }
  }
  // 日期（11/16、11月16日）：即使訊息裡還有品項也要抓，更新取餐時間
  const dateM = text.match(/(\d{1,2})\/(\d{1,2})|(\d{1,2})月(\d{1,2})[日號]/);
  if (dateM) out.dateStr = dateM[0];
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
  // 整筆備註（半飯、少飯、加飯、換地瓜等）：先抓關鍵字，細節交給 LLM 或老闆確認
  const noteM = text.match(/(半飯|少飯|加飯|多飯|白飯換地瓜|換地瓜|不要飯|去飯|醬多|醬少|少醬)/);
  if (noteM) out.generalNote = noteM[0];
  return out;
}

// LLM 格式跑掉時的救援：把抓到的資訊併入訂單，盡量完成流程
function salvageResult(text, order) {
  const s = salvage(text);
  // 純時間／日期回答（例：「10/20中午11點」「明天下午2點」）：當作取餐時間
  const isTimeOnly = !s.name && !s.phone && !s.address && !s.items.length &&
    /(\d\s*[點:：]|\/|明天|後天|大後天|週[一二三四五六日天])/.test(text);

  if (!order) {
    return { reply: '不好意思，我剛剛沒聽清楚，可以再說一次嗎？', order: null, customer_note: null };
  }

  let updated = false;
  if (s.items.length) { order.items = s.items; updated = true; }
  if (s.name) { order.name = s.name; updated = true; }
  if (s.phone) { order.phone = s.phone; updated = true; }
  if (s.address) { order.address = s.address; updated = true; }
  if (s.generalNote) { order.generalNote = s.generalNote; updated = true; }
  if (isTimeOnly && !order.pickup_time) { order.pickup_time = text.trim(); updated = true; }
  // 抓到日期（如 11/16）：併入取餐時間
  if (s.dateStr) {
    const timePart = order.pickup_time && !/\d+\/\d+/.test(order.pickup_time) ? ` ${order.pickup_time}` : '';
    const newPickup = `${s.dateStr}${timePart}`.trim();
    if (order.pickup_time !== newPickup) { order.pickup_time = newPickup; updated = true; }
  }

  if (!updated) {
    return { reply: '不好意思，我剛剛沒聽清楚，可以再說一次嗎？', order: null, customer_note: null };
  }

  // 品項＋姓名＋電話都有了 → 給訂單摘要請客人確認
  if (order.name && order.phone && order.items && order.items.length) {
    return { reply: orderSummary(order), order: { ...order, status: 'confirming' }, customer_note: null };
  }
  // 還缺資料 → 問缺的
  const missing = [];
  if (!order.items || !order.items.length) missing.push('餐點品項');
  if (!order.pickup_time) missing.push('取餐時間');
  if (!order.name) missing.push('稱呼');
  if (!order.phone) missing.push('電話');
  return {
    reply: `好的，記下了。再麻煩提供${missing.join('、')}，我們好為您完成預訂，謝謝！`,
    order: { ...order, status: 'collecting' },
    customer_note: null,
  };
}

async function handleMessage(event) {
  const userId = event.source.userId;
  const text = (event.message.text || '').trim();
  if (!text) return;

  // 老闆指令（只認 BOSS_USER_ID）
  if (BOSS_USER_ID && userId === BOSS_USER_ID) {
    if (/^(暫停全部|全部暫停)$/.test(text)) {
      manualPaused = true;
      pauseUntil = Date.now() + 60 * 60 * 1000;
      await lineReply(event.replyToken, ['收到，這 1 小時我不會回任何客人。輸入「恢復」可提早回來。']);
      return;
    }
    if (/^(暫停|接管|手動)$/.test(text)) {
      // 只對最近一位客人噤聲
      if (lastCustomer) {
        pausedUsers.set(lastCustomer, Date.now() + 60 * 60 * 1000);
        let who = '最近一位客人';
        try {
          const p = await db.getProfile(lastCustomer);
          if (p && (p.name || p.phone)) who = `${p.name || '未留名'}${p.phone ? ' ' + p.phone : ''}`;
        } catch (e) {}
        await lineReply(event.replyToken, [`已對「${who}」噤聲 1 小時，其他客人我照常回。輸入「恢復」可提早回來。`]);
      } else {
        await lineReply(event.replyToken, ['目前沒有客人在聊天，不用暫停。']);
      }
      return;
    }
    if (/^(恢復|繼續|自動)$/.test(text)) {
      manualPaused = false;
      pausedUsers.clear();
      await lineReply(event.replyToken, ['我回來了，自動回覆已全部恢復。']);
      return;
    }
    // 老闆的其他訊息照常當測試處理
  }

  // 記錄最近一位客人（老闆本人不算）
  if (!BOSS_USER_ID || userId !== BOSS_USER_ID) {
    lastCustomer = userId;
  }

  // 檢查是否被噤聲（單一或全部）
  const now = Date.now();
  const singleExpiry = pausedUsers.get(userId) || 0;
  if (singleExpiry && now > singleExpiry) pausedUsers.delete(userId); // 逾時清除
  const isSinglePaused = pausedUsers.has(userId);
  if (manualPaused && now > pauseUntil) manualPaused = false; // 全部暫停逾時自動恢復

  if (manualPaused || isSinglePaused) {
    // 靜默：訊息照樣存檔（老闆可在試算表看到），不回覆
    const session = await db.getSession(userId);
    session.history.push({ role: 'user', content: text });
    session.history = session.history.slice(-MAX_HISTORY);
    await db.saveSession(userId);
    return;
  }

  const session = await db.getSession(userId);
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
    await db.saveSession(userId);
    return;
  }

  // LLM 兩次格式都跑掉：用正規表示式救援，盡量把訂單完成，不跟客人說沒聽清楚
  if (result.parseFailed) {
    console.error('[salvage] regex rescue for:', text.slice(0, 60));
    result = salvageResult(text, session.order);
  }

  // === 訂單狀態機（程式碼主導，不再信任 LLM 的 status）===
  // LLM 只負責：reply 口氣 ＋ 抽取欄位（品項/時間/姓名/電話/地址）
  const fields = result.order || {};

  // 作弊日營業日檢查（程式碼擋下，不靠 prompt）
  const cheatErr = checkCheatDay(fields.items || (session.order && session.order.items), fields.pickup_time || (session.order && session.order.pickup_time));
  if (cheatErr) {
    session.history.push({ role: 'assistant', content: cheatErr });
    await db.saveSession(userId);
    await lineReply(event.replyToken, [cheatErr]);
    return;
  }

  // 合併欄位到進行中的訂單
  let order = session.order;
  if (!order && fields.items && fields.items.length) {
    order = { items: fields.items, status: 'collecting' };
  }
  if (order) {
    if (fields.items && fields.items.length) order.items = fields.items;
    if (fields.pickup_time) order.pickup_time = fields.pickup_time;
    if (fields.name) order.name = fields.name;
    if (fields.phone) order.phone = fields.phone;
    if (fields.address) order.address = fields.address;
    if (fields.generalNote) order.generalNote = fields.generalNote;
  }

  let replyText = result.reply || '收到！';

  // collecting → confirming：品項＋姓名＋電話齊了，程式產生摘要
  if (order && order.status === 'collecting' && order.items && order.items.length && order.name && order.phone) {
    order.status = 'confirming';
    replyText = orderSummary(order);
  }
  // confirming → confirmed：只有明確說「確認」才算成立
  else if (order && order.status === 'confirming' && isConfirmText(text)) {
    order.status = 'confirmed';
    replyText = `好的，${order.name}！訂單成立，我們會妥善安排，謝謝您的訂購！`;
  }
  // confirming 但說了別的 → 回到 collecting，用 LLM 的回覆處理修改
  else if (order && order.status === 'confirming') {
    order.status = 'collecting';
  }

  session.history.push({ role: 'assistant', content: replyText });
  session.order = order && order.status !== 'none' ? order : null;

  // 訂單剛被確認：寫入客人檔案＋推播通知老闆（每單扣 1 則額度）
  if (order && order.status === 'confirmed') {
    console.log('[ORDER CONFIRMED]', JSON.stringify({ userId, ...order }));
    await db.saveOrder({ userId, name: order.name, phone: order.phone, items: order.items, pickup_time: order.pickup_time });
    if (BOSS_USER_ID) {
      const lines = (order.items || []).map((i) => `・${i.name} x${i.qty}${i.note ? `（${i.note}）` : ''}`).join('\n');
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

  await db.saveSession(userId); // 每次處理完寫回試算表，部署重啟不遺失
  await lineReply(event.replyToken, [replyText]);
}

module.exports = { handleMessage, orderSummary };
