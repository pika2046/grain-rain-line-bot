// 艾琳林小姐訂單本地測試：不連 LINE、不連試算表
// 背景（2026-11-12）：客人林小姐用公司行號格式下單，訊息裡明明寫了
// 「聯絡人：林小姐」「聯絡人電話：2160121#2232」，艾琳卻回「再麻煩提供稱呼、電話」。
// 根因有二：(1) SURNAMES 缺「林」，姓名救援抓不到「林小姐」；(2) PHONE_RE 市話分支
// 要求 0 開頭，無區碼 7 碼市話＋分機「2160121#2232」抓不到。另修：品名後接
// 價格再接 *數量（「海南雞腿排$150*2」「泰式低脂打拋豬肉135*1」）舊版抓不到品項，
// 且第一輪 \s* 會跨行把上一行數量配到下一行品名（誤抓魚柳 x1）；日期後的時刻
// （11:50）舊版會掉，只剩日期。
// 用法：node test-lin-order.js
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'dummy';
process.env.BOSS_USER_ID = 'U_boss_test';

const path = require('path');

// ---- 假 LLM：模擬真實狀況 — LLM 沒抽出欄位（parseFailed），走正規救援 ----
function fakeChat() {
  return Promise.resolve({ parseFailed: true });
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

const LIN_MSG = [
  '海南雞腿排$150*2',
  '（1少飯不要青蔥醬）',
  '泰式低脂打拋豬肉135*1',
  '嫩煎虱目魚柳$135*2',
  '',
  '共5個705元',
  '不要筷子',
  '聯絡人：林小姐',
  '聯絡人電話：2160121#2232',
  '',
  '外送地址：台電側門守衛室(忠義路一段109號)',
  '11/13(五)11:50',
].join('\n');

async function send(uid, text) {
  const before = replies.length;
  await handleMessage({ source: { userId: uid }, message: { text }, replyToken: `tok-${Date.now()}-${Math.random()}` });
  return replies.slice(before).map((r) => r.texts.join('\n'));
}

(async () => {
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log(`PASS ${name}`); }
    else { fail++; console.log(`FAIL ${name}:: ${detail}`); }
  };
  const hasItem = (items, name, qty) => (items || []).some((i) => i.name === name && i.qty === qty);

  // ---- salvage 單元檢查 ----
  let s = salvage(LIN_MSG);
  check('salvage 姓名林小姐', s.name === '林小姐', JSON.stringify(s.name));
  check('salvage 電話2160121#2232', s.phone === '2160121#2232', JSON.stringify(s.phone));
  check('salvage 海南雞腿排 x2', hasItem(s.items, '海南雞腿排', 2), JSON.stringify(s.items));
  check('salvage 泰式打拋豬 x1', hasItem(s.items, '泰式打拋豬', 1), JSON.stringify(s.items));
  check('salvage 嫩煎台南虱目魚柳 x2', hasItem(s.items, '嫩煎台南虱目魚柳', 2), JSON.stringify(s.items));
  check('salvage 品項共3項', s.items.length === 3, JSON.stringify(s.items));
  check('salvage 地址台電側門守衛室', (s.address || '').includes('台電側門守衛室'), JSON.stringify(s.address));
  check('salvage 日期11/13＋時刻11:50', s.dateStr === '11/13' && s.timeStr === '11:50', JSON.stringify([s.dateStr, s.timeStr]));

  check('salvage 手機帶分隔符', salvage('手機0937-930160').phone === '0937930160', JSON.stringify(salvage('手機0937-930160').phone));
  check('salvage 市話含區碼＋分機', salvage('電話：06-2160121#2232').phone === '062160121#2232', JSON.stringify(salvage('電話：06-2160121#2232').phone));
  check('salvage 標籤式無區碼市話', salvage('聯絡人電話：2160121').phone === '2160121', JSON.stringify(salvage('聯絡人電話：2160121').phone));
  check('salvage 統編不誤認成電話', salvage('統編 25765328').phone === null, JSON.stringify(salvage('統編 25765328').phone));
  check('salvage 2個雞胸', hasItem(salvage('我要2個雞胸').items, '厚切舒肥嫩雞胸', 2), JSON.stringify(salvage('我要2個雞胸').items));
  check('salvage 海南雞腿排6盒', hasItem(salvage('海南雞腿排6盒').items, '海南雞腿排', 6), JSON.stringify(salvage('海南雞腿排6盒').items));
  check('salvage 虱目魚柳 x1', hasItem(salvage('虱目魚柳 x1').items, '嫩煎台南虱目魚柳', 1), JSON.stringify(salvage('虱目魚柳 x1').items));
  check('salvage 陳先生姓名', salvage('我姓陳，陳先生').name === '陳先生', JSON.stringify(salvage('我姓陳，陳先生').name));
  check('salvage 客人自算總額705', s.customer_total === 705, JSON.stringify(s.customer_total));
  check('salvage 客人自算共5個', s.customer_count === 5, JSON.stringify(s.customer_count));
  check('salvage 不要筷子放整筆備註', s.generalNote === '不要筷子', JSON.stringify(s.generalNote));
  check('salvage 少飯掛海南雞腿排', (s.items.find((i) => i.name === '海南雞腿排') || {}).note === '少飯、不要青蔥醬', JSON.stringify(s.items));
  check('salvage 只有打拋豬少飯歸屬', (() => {
    const t = salvage('泰式打拋豬 x2\n嫩煎虱目魚柳 x2\n只有泰式打拋豬少飯');
    const dp = t.items.find((i) => i.name === '泰式打拋豬');
    return dp && dp.note === '少飯' && t.generalNote !== '少飯';
  })(), JSON.stringify(salvage('泰式打拋豬 x2\n嫩煎虱目魚柳 x2\n只有泰式打拋豬少飯')));

  // ---- 端到端重演：LLM 解析失敗 → 救援應直接成立訂單（2026-11-17 改：不再等客人回「確認」，
  // 資料齊了核對金額後直接登記、通知老闆），不再問稱呼電話 ----
  const r = await send('U_lin', LIN_MSG);
  const joined = r.join('\n');
  check('重演 直接成立收據', joined.includes('已幫您登記訂單'), joined);
  check('重演 不再問確認', !joined.includes('請回「確認」') && !joined.includes('跟你確認一下訂單'), joined);
  check('重演 不再問稱呼電話', !joined.includes('再麻煩提供'), joined);
  check('重演 摘要有林小姐', joined.includes('林小姐'), joined);
  check('重演 摘要有2160121#2232', joined.includes('2160121#2232'), joined);
  check('重演 摘要品項數量正確', joined.includes('海南雞腿排 x2') && joined.includes('泰式打拋豬 x1') && joined.includes('嫩煎台南虱目魚柳 x2'), joined);
  check('重演 摘要時間11/13 11:50', joined.includes('11/13 11:50'), joined);
  check('重演 摘要地址', joined.includes('台電側門守衛室'), joined);
  check('重演 訂單狀態confirmed', sessions.get('U_lin').order && sessions.get('U_lin').order.status === 'confirmed', JSON.stringify(sessions.get('U_lin').order));
  check('重演 總計705元', joined.includes('總計 $705 元'), joined);
  check('重演 備註不要筷子有保留', joined.includes('備註：不要筷子'), joined);
  check('重演 少飯只掛海南雞腿排', joined.includes('海南雞腿排 x2（少飯、不要青蔥醬）') && !joined.includes('泰式打拋豬 x1（少飯'), joined);
  check('重演 老闆收到新訂單推播', replies.some((x) => x.to === 'U_boss_test' && x.texts.join('\n').includes('【新訂單】')), JSON.stringify(replies.map((x) => x.to)));
  check('重演 訂單已寫入', fakeDb._orders.length === 1 && fakeDb._orders[0].name === '林小姐', JSON.stringify(fakeDb._orders.length));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
