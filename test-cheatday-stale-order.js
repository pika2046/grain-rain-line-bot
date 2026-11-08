// 艾琳作弊日誤攔截本地測試：不連 LINE、不連試算表
// 事故（2026-11-08）：鈞鋒公司 10/28 舊單（作弊日一號 x4，未確認）殘留在 session.order，
// 11/08 新下 11/10 海南雞腿排 x6，艾琳卻回「作弊日餐點只有週五、週六才有供應」。
// 用法：node test-cheatday-stale-order.js
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'dummy';
process.env.BOSS_USER_ID = 'U_boss_test';

const path = require('path');

// ---- 假 LLM：依測試情境回傳（模擬真實 LLM 兩種失誤）----
let llmMode = 'miss-items'; // miss-items | merge-history | normal
const NEW_ORDER = {
  pickup_time: '11/10（二）11:00',
  name: '鈞鋒公司',
  phone: '062912171',
  address: '台南市南區新愛路38號之1',
};
function fakeChat(history) {
  const lastUser = [...history].reverse().find((h) => h.role === 'user');
  const text = lastUser ? lastUser.content : '';
  if (llmMode === 'miss-items') {
    // LLM 抽到了日期／姓名／電話／地址，唯獨沒抽到品項（真實事故的可能路徑之一）
    return Promise.resolve({ reply: '好的，記下了。', order: { ...NEW_ORDER }, need_human: false, parseFailed: false });
  }
  if (llmMode === 'merge-history') {
    // LLM 把對話歷史裡的舊品項也帶進新單（真實事故的另一可能路徑）
    return Promise.resolve({
      reply: '好的，記下了。',
      order: { ...NEW_ORDER, items: [
        { name: '海南雞腿排', qty: 6, note: '四盒加飯' },
        { name: '作弊日一號 阿嬤爌肉＋滷雞腿', qty: 4, note: null },
        { name: '嫩煎台南虱目魚柳', qty: 1, note: '半飯' },
      ] },
      need_human: false, parseFailed: false,
    });
  }
  // normal：只抽本次訊息（改日期的訊息）
  const dateM = text.match(/(\d{1,2}\/\d{1,2})/);
  return Promise.resolve({
    reply: '好的，記下了。',
    order: dateM ? { pickup_time: dateM[0] } : null,
    need_human: false, parseFailed: false,
  });
}

// ---- 假客人檔案：記憶體版 ----
const sessions = new Map();
const fakeDb = {
  getSession: async (uid) => {
    if (!sessions.has(uid)) sessions.set(uid, { history: [], order: null });
    return sessions.get(uid);
  },
  saveSession: async () => {},
  getProfile: async () => ({ name: null, orderCount: '0' }),
  saveOrder: async (o) => { fakeDb._orders.push(o); },
  updateNote: async () => {},
  _orders: [],
};

// ---- 攔截 require：llm 與 customer-db 換成假的 ----
const llmPath = path.resolve(__dirname, 'lib/llm.js');
const dbPath = path.resolve(__dirname, 'lib/customer-db.js');
require.cache[llmPath] = { exports: { chat: fakeChat } };
require.cache[dbPath] = { exports: fakeDb };

// ---- 攔截 fetch：LINE reply/push 只記錄不送出 ----
const replies = [];
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  if (url.includes('/message/reply')) replies.push({ to: 'reply', texts: body.messages.map((m) => m.text) });
  if (url.includes('/message/push')) replies.push({ to: body.to, texts: body.messages.map((m) => m.text) });
  return { ok: true, text: async () => '' };
};

const { handleMessage, salvage } = require('./lib/handler');

const OLD_ORDER = {
  items: [
    { name: '作弊日一號 阿嬤爌肉＋滷雞腿', qty: 4, note: null },
    { name: '嫩煎台南虱目魚柳', qty: 1, note: '半飯' },
  ],
  pickup_time: '10/28（三）11:00',
  name: '鈞鋒公司',
  phone: '062912171',
  address: '台南市南區新愛路38號之1',
  status: 'collecting',
};
const NEW_MSG = '11/10（二）11:00\n聯絡人：鈞鋒公司\n電話：062912171\n外送地址：外送台南市南區新愛路38號之1\n\n餐盒名稱及數量：\n海南雞腿排6盒（四盒加飯）';

function seedOldOrder(uid) {
  sessions.set(uid, {
    history: [
      { role: 'user', content: '我要作弊日一號4個、嫩煎虱目魚柳1個（半飯），10/28 11:00 外送到台南市南區新愛路38號之1' },
      { role: 'assistant', content: '跟你確認一下訂單：\n・作弊日一號 阿嬤爌肉＋滷雞腿 x4\n・嫩煎台南虱目魚柳 x1（半飯）\n取餐時間：10/28（三）11:00\n姓名：鈞鋒公司　電話：062912171\n外送地址：台南市南區新愛路38號之1\n沒問題請回「確認」，要改直接跟我說！' },
    ],
    order: JSON.parse(JSON.stringify(OLD_ORDER)),
  });
}

async function send(uid, text) {
  const before = replies.length;
  await handleMessage({ source: { userId: uid }, message: { text }, replyToken: `tok-${Date.now()}-${Math.random()}` });
  return replies.slice(before).map((r) => r.texts.join('\n'));
}

(async () => {
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log(`PASS ${name}`); }
    else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
  };
  const CHEAT_MSG = '作弊日餐點只有週五、週六才有供應';

  // 情境 1：事故重演 — LLM 沒抽到品項（miss-items）
  llmMode = 'miss-items';
  seedOldOrder('U_jun1');
  let r = await send('U_jun1', NEW_MSG);
  check('1a 新單不再誤觸作弊日攔截', !r.join('').includes(CHEAT_MSG), r.join(' | '));
  check('1b 新單出訂單摘要', r.join('').includes('跟你確認一下訂單'), r.join(' | '));
  check('1c 摘要只有海南雞腿排 x6、沒有舊品項',
    r.join('').includes('海南雞腿排 x6') && !r.join('').includes('作弊日一號') && !r.join('').includes('虱目魚柳'),
    r.join(' | '));
  check('1d 殘留舊單已清掉、新單取餐日為 11/10',
    sessions.get('U_jun1').order && sessions.get('U_jun1').order.pickup_time === '11/10（二）11:00',
    JSON.stringify(sessions.get('U_jun1').order));

  // 情境 2：事故重演 — LLM 把歷史舊品項帶進新單（merge-history）
  llmMode = 'merge-history';
  seedOldOrder('U_jun2');
  r = await send('U_jun2', NEW_MSG);
  check('2a 合併舊品項的新單不再誤觸作弊日攔截', !r.join('').includes(CHEAT_MSG), r.join(' | '));
  check('2b 摘要只有海南雞腿排 x6、舊品項已剔除',
    r.join('').includes('海南雞腿排 x6') && !r.join('').includes('作弊日一號') && !r.join('').includes('虱目魚柳'),
    r.join(' | '));

  // 情境 3：多輪訂餐保護 — 同一筆單只改日期到週二，作弊日檢查照常擋下
  llmMode = 'normal';
  seedOldOrder('U_jun3');
  r = await send('U_jun3', '改到 11/10 取餐');
  check('3 改日期到週二、作弊日檢查照常擋下', r.join('').includes(CHEAT_MSG), r.join(' | '));

  // 情境 4：salvage 單元 —「品項＋數量」寫法
  const s1 = salvage('海南雞腿排6盒（四盒加飯）');
  check('4a salvage 抓到海南雞腿排 x6', s1.items.length === 1 && s1.items[0].name === '海南雞腿排' && s1.items[0].qty === 6, JSON.stringify(s1.items));
  check('4b salvage 抓到加飯備註', s1.generalNote === '加飯', JSON.stringify(s1));
  const s2 = salvage('嫩煎虱目魚柳 x1（半飯）');
  check('4c salvage 抓到魚柳 x1', s2.items.length === 1 && s2.items[0].name === '嫩煎台南虱目魚柳' && s2.items[0].qty === 1, JSON.stringify(s2.items));
  const s3 = salvage('作弊日一號 x4');
  check('4d salvage 抓到作弊日一號 x4', s3.items.length === 1 && s3.items[0].name === '作弊日一號 阿嬤爌肉＋滷雞腿' && s3.items[0].qty === 4, JSON.stringify(s3.items));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
