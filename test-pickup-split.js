// 艾琳自取分流本地測試：不連 LINE、不連試算表，測 handler.js 的攔截＋狀態機
// 用法：node test-pickup-split.js
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'dummy';
process.env.BOSS_USER_ID = 'U_boss_test';

const path = require('path');
const Module = require('module');

// ---- 假 LLM：依最後一則使用者訊息抽取欄位（模擬真實 LLM 會做的事）----
const ITEM_MAP = [
['韓式醬烤梅花豬', '韓式醬烤梅花豬'], ['梅花豬', '韓式醬烤梅花豬'],
['厚切舒肥雞胸肉', '厚切舒肥嫩雞胸'], ['舒肥雞胸', '厚切舒肥嫩雞胸'],
['雞胸', '厚切舒肥嫩雞胸'],
];
function fakeChat(history) {
const lastUser = [...history].reverse().find((h) => h.role === 'user');
const text = lastUser? lastUser.content: '';
const order = { items: []};
for (const [kw, name] of ITEM_MAP) {
const m = text.match(new RegExp(`(\\d+)\\s*個?${kw}`)) || (text.includes(kw)? [null, '1']: null);
if (m &&!order.items.find((i) => i.name === name)) order.items.push({ name, qty: parseInt(m[1], 10), note: null});
}
const phoneM = text.match(/09\d{2}[-]?\d{3}[-]?\d{3}/);
if (phoneM) order.phone = phoneM[0].replace(/\D/g, '');
const nameM = text.match(/我姓(\S)/) || text.match(/([王李張劉陳楊黃趙吳周徐孫馬朱胡郭何羅梁鄭謝宋唐鄧韓馮董蕭程曹袁許傅沈曾彭呂蘇盧蔣蔡賈丁魏薛葉閻余潘杜戴夏鍾汪田任姜范方石姚譚廖鄒熊金陸郝孔白崔康毛邱秦江史顧侯邵孟龍萬段雷錢湯尹黎易常武喬賀賴龔文])(小姐|先生)/);
if (nameM) order.name = nameM[1] + (nameM[2] || '小姐');
const addrM = text.match(/送到(.+)$/);
if (addrM) order.address = addrM[1].trim();
if (/出發過去拿|中午12點|明天中午/.test(text)) order.pickup_time = text;
if (!order.items.length) delete order.items;
const reply = order.items? '收到，記下了。': '您好，請問需要什麼呢？';
return Promise.resolve({ reply, order: Object.keys(order).length? order: null, need_human: false, parseFailed: false});
}

// ---- 假客人檔案：記憶體版 ----
const sessions = new Map();
const fakeDb = {
getSession: async (uid) => {
if (!sessions.has(uid)) sessions.set(uid, { history: [], order: null});
return sessions.get(uid);
},
saveSession: async () => {},
getProfile: async () => ({ name: null, orderCount: '0'}),
saveOrder: async (o) => { fakeDb._orders.push(o);},
updateNote: async () => {},
_orders: [],
};

// ---- 攔截 require：llm 與 customer-db 換成假的 ----
const llmPath = path.resolve(__dirname, 'lib/llm.js');
const dbPath = path.resolve(__dirname, 'lib/customer-db.js');
require.cache[llmPath] = { exports: { chat: fakeChat}};
require.cache[dbPath] = { exports: fakeDb};

// ---- 攔截 fetch：LINE reply/push 只記錄不送出 ----
const replies = []; // {to, texts}
global.fetch = async (url, opts) => {
const body = JSON.parse(opts.body);
if (url.includes('/message/reply')) replies.push({ to: 'reply', texts: body.messages.map((m) => m.text)});
if (url.includes('/message/push')) replies.push({ to: body.to, texts: body.messages.map((m) => m.text)});
return { ok: true, text: async () => ''};
};

const { handleMessage} = require('./lib/handler');
const LINK = 'line://app/1607331440-2dNpzWeB?type=order&id=d3f611418e5e4edb8eeb0bb754af3317';

async function send(uid, text) {
const before = replies.length;
await handleMessage({ source: { userId: uid}, message: { text}, replyToken: `tok-${Date.now()}-${Math.random()}`});
return replies.slice(before).map((r) => r.texts.join('\n'));
}

(async () => {
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
if (cond) { pass++; console.log(`PASS ${name}`);}
else { fail++; console.log(`FAIL ${name}:: ${detail}`);}
};

// 情境 1：唐小姐自取重演 — 點餐後說「現在出發過去拿」，再給姓名電話、回確認
let r = await send('U_tang', '我要韓式醬烤梅花豬1個、厚切舒肥雞胸肉1個');
r = await send('U_tang', '現在出發過去拿');
check('1a 自取攔截回導向＋連結', r.join('').includes('LINE 這邊是接外送預訂') && r.join('').includes(LINK), r.join(' | '));
check('1b 攔截後訂單清空', sessions.get('U_tang').order === null, JSON.stringify(sessions.get('U_tang').order));
r = await send('U_tang', '我姓唐，唐小姐');
r = await send('U_tang', '手機09-2872-0980');
r = await send('U_tang', '確認');
check('1c 後續確認不會成立訂單',!r.join('').includes('訂單成立') && fakeDb._orders.length === 0, r.join(' | '));

// 情境 2：外送預訂正常流程 — 有地址 → 摘要 → 確認 → 成立＋老闆推播
await send('U_chen', '我要2個雞胸，明天中午12點送到台南市南區永華路一段255號');
await send('U_chen', '我姓陳');
r = await send('U_chen', '0912345678');
check('2a 外送有地址會直接成立收據（2026-11-17 改：不再等確認）', r.join('').includes('已幫您登記訂單') && r.join('').includes('外送地址'), r.join(' | '));
r = await send('U_chen', '確認');
check('2b 外送已直接成立、確認不重複', fakeDb._orders.length === 1 && sessions.get('U_chen').order && sessions.get('U_chen').order.status === 'confirmed', r.join(' | '));
check('2c 老闆收到推播', replies.some((x) => x.to === 'U_boss_test' && x.texts.join('').includes('')), JSON.stringify(replies.filter((x) => x.to === 'U_boss_test').length));

// 情境 3：沒地址也沒自取關鍵字 — 不出摘要，改問外送地址＋附自取連結；確認也不成立
await send('U_amb', '我要2個雞胸');
await send('U_amb', '明天中午');
await send('U_amb', '我姓林');
r = await send('U_amb', '0922333444');
check('3a 無地址不出摘要、改問地址＋附連結',!r.join('').includes('跟你確認一下訂單') && r.join('').includes('外送地址') && r.join('').includes(LINK), r.join(' | '));
r = await send('U_amb', '確認');
check('3b 無地址確認也不成立',!r.join('').includes('訂單成立'), r.join(' | '));
check('3c 訂單總數仍只有外送那 1 筆', fakeDb._orders.length === 1, String(fakeDb._orders.length));

// 情境 4：第一則就說自取＋品項 — 立即導向，不建單
r = await send('U_first', '我要自取，2個雞胸');
check('4 自取首則即導向', r.join('').includes('LINE 這邊是接外送預訂') && r.join('').includes(LINK), r.join(' | '));
check('4b 未建單', sessions.get('U_first').order === null, JSON.stringify(sessions.get('U_first').order));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail? 1: 0);
})();
