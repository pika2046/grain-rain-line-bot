// 艾琳自動成立訂單本地測試：不連 LINE、不連試算表
// 背景（2026-11-17 老闆指示）：艾琳不要一直問客人「確認」；客人下單後先統計數量金額，
// 正確無誤就直接登記、通知老闆；客人自己算錯總額時艾琳要發現並糾正。
// 用法：node test-auto-confirm.js
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'dummy';
process.env.BOSS_USER_ID = 'U_boss_test';

const path = require('path');

let forceParseFailed = false;

function fullOrder(total, count) {
return {
items: [
{ name: '泰式打拋豬', qty: 2, note: null},
{ name: '嫩煎台南虱目魚柳', qty: 2, note: null},
{ name: '和風壽喜牛丼', qty: 1, note: null},
],
pickup_time: '11/18 11:50',
name: '林小姐',
phone: '2160121#2232',
address: '台電側門守衛室(忠義路一段109號)',
generalNote: '不要筷子',
customer_total: total,
customer_count: count,
};
}

// ---- 假 LLM：依最後一則客人訊息回罐頭 JSON ----
function fakeChat(history) {
if (forceParseFailed) return Promise.resolve({ parseFailed: true});
const last = (history[history.length - 1] || {}).content || '';
if (last.includes('只有泰式打拋豬少飯')) {
return Promise.resolve({ reply: '好的', need_human: false, order: { items: [{ name: '泰式打拋豬', qty: 2, note: '少飯'}]}, customer_note: null});
}
if (last.includes('720元')) {
return Promise.resolve({ reply: '收到！', need_human: false, order: fullOrder(720, 6), customer_note: null});
}
if (last.includes('690元')) {
return Promise.resolve({ reply: '收到！', need_human: false, order: fullOrder(690, 5), customer_note: null});
}
if (last.includes('我要2個雞胸')) {
return Promise.resolve({ reply: '好的，雞胸2個。', need_human: false, order: { items: [{ name: '厚切舒肥嫩雞胸', qty: 2, note: null}]}, customer_note: null});
}
return Promise.resolve({ reply: '好的', need_human: false, order: null, customer_note: null});
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
const replies = [];
global.fetch = async (url, opts) => {
const body = JSON.parse(opts.body);
if (url.includes('/message/reply')) replies.push({ to: 'reply', texts: body.messages.map((m) => m.text)});
if (url.includes('/message/push')) replies.push({ to: body.to, texts: body.messages.map((m) => m.text)});
return { ok: true, text: async () => ''};
};

const { handleMessage} = require('./lib/handler');

const MSG_CORRECT = [
'泰式低脂打拋豬肉135*2',
'嫩煎虱目魚柳$135*2',
'壽喜牛肉$150*1',
'共5個690元',
'不要筷子',
'聯絡人：林小姐',
'聯絡人電話：2160121#2232',
'外送地址：台電側門守衛室(忠義路一段109號)',
'11/18(三)11:50',
].join('\n');

const MSG_WRONG_TOTAL = MSG_CORRECT.replace('共5個690元', '共6個720元');

async function send(uid, text) {
const before = replies.length;
await handleMessage({ source: { userId: uid}, message: { text}, replyToken: `tok-${Date.now()}-${Math.random()}`});
return replies.slice(before).map((r) => r.texts.join('\n'));
}
const pushesToBoss = () => replies.filter((r) => r.to === 'U_boss_test').map((r) => r.texts.join('\n'));

(async () => {
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
if (cond) { pass++; console.log(`PASS ${name}`);}
else { fail++; console.log(`FAIL ${name}:: ${detail}`);}
};

// 1. 完整訂單、總額正確 → 直接成立，不問確認
let r = await send('U_auto1', MSG_CORRECT);
let joined = r.join('\n');
check('正確總額 直接成立收據', joined.includes('已幫您登記訂單'), joined);
check('正確總額 不問確認',!joined.includes('請回「確認」'), joined);
check('正確總額 總計690', joined.includes('總計 $690 元'), joined);
check('正確總額 備註不要筷子', joined.includes('備註：不要筷子'), joined);
check('正確總額 老闆推播新訂單', pushesToBoss().some((t) => t.includes('') && t.includes('總計 $690 元')), JSON.stringify(pushesToBoss()));
check('正確總額 訂單寫入1筆', fakeDb._orders.length === 1, JSON.stringify(fakeDb._orders.length));
check('正確總額 狀態confirmed', sessions.get('U_auto1').order && sessions.get('U_auto1').order.status === 'confirmed', JSON.stringify(sessions.get('U_auto1').order));

// 2. 客人自算總額錯誤（720 元／6 個，正確 690 元／5 個）→ 糾正後用正確金額成立
r = await send('U_auto2', MSG_WRONG_TOTAL);
joined = r.join('\n');
check('錯誤總額 仍直接成立', joined.includes('已幫您登記訂單'), joined);
check('錯誤總額 告知正確金額', joined.includes('720 元') && joined.includes('690 元'), joined);
check('錯誤總額 收據用正確總計', joined.includes('總計 $690 元'), joined);
check('錯誤總額 老闆推播有金額更正', pushesToBoss().some((t) => t.includes('') && t.includes('720 元') && t.includes('690 元')), JSON.stringify(pushesToBoss()));
check('錯誤總額 訂單寫入共2筆', fakeDb._orders.length === 2, JSON.stringify(fakeDb._orders.length));

// 3. 成立後修改備註（LLM 路徑）：「只有泰式打拋豬少飯」→ 只改打拋豬，不重複寫檔
const pushesBefore = pushesToBoss().length;
r = await send('U_auto1', '只有泰式打拋豬少飯');
joined = r.join('\n');
check('修改備註 老闆收到訂單修改', pushesToBoss().length === pushesBefore + 1 && pushesToBoss().slice(-1)[0].includes(''), JSON.stringify(pushesToBoss().slice(-1)));
check('修改備註 少飯只在打拋豬', joined.includes('泰式打拋豬 x2（少飯）') &&!joined.includes('魚柳 x2（少飯') &&!joined.includes('備註：少飯'), joined);
check('修改備註 收據是更新版', joined.includes('訂單已更新'), joined);
check('修改備註 不重複寫檔', fakeDb._orders.length === 2, JSON.stringify(fakeDb._orders.length));

// 4. 成立後客人回「確認」→ 不重複成立、不重推老闆
const pushesBefore2 = pushesToBoss().length;
r = await send('U_auto1', '確認');
check('確認後不重複推播', pushesToBoss().length === pushesBefore2, JSON.stringify(pushesToBoss().length));
check('確認後不重複寫檔', fakeDb._orders.length === 2, JSON.stringify(fakeDb._orders.length));

// 5. 資料不全 → 問缺的，不成立
r = await send('U_auto3', '我要2個雞胸');
joined = r.join('\n');
check('資料不全 問缺的', joined.includes('再麻煩提供'), joined);
check('資料不全 不成立',!joined.includes('已幫您登記訂單') && fakeDb._orders.length === 2, joined);

// 6. 成立後取消 → 訂單清除、老闆收到取消推播
r = await send('U_auto1', '取消');
joined = r.join('\n');
check('取消 回覆已取消', joined.includes('已經幫您取消'), joined);
check('取消 訂單清除', sessions.get('U_auto1').order === null, JSON.stringify(sessions.get('U_auto1').order));
check('取消 老闆收到取消推播', pushesToBoss().some((t) => t.includes('')), JSON.stringify(pushesToBoss().slice(-1)));

// 7. 救援路徑（LLM 解析失敗）：完整訂單成立＋成立後改備註
forceParseFailed = true;
r = await send('U_auto4', MSG_CORRECT);
joined = r.join('\n');
check('救援路徑 直接成立', joined.includes('已幫您登記訂單') && joined.includes('總計 $690 元'), joined);
const ordersBefore = fakeDb._orders.length;
r = await send('U_auto4', '只有泰式打拋豬少飯');
joined = r.join('\n');
check('救援路徑 修改備註推播老闆', pushesToBoss().slice(-1)[0].includes(''), JSON.stringify(pushesToBoss().slice(-1)));
check('救援路徑 少飯只在打拋豬', joined.includes('泰式打拋豬 x2（少飯）') &&!joined.includes('備註：少飯'), joined);
check('救援路徑 不重複寫檔', fakeDb._orders.length === ordersBefore, JSON.stringify(fakeDb._orders.length));
forceParseFailed = false;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail? 1: 0);
})();
