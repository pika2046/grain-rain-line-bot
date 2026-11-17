// 王先生團體訂單本地測試：不連 LINE、不連試算表
// 事故（2026-11-17 19:22）：客人一次幫 17 人點 18 盒、每行「名字：品項 $價格」，
// 又寫「共$1675」「明天11:40」「台南市政府交通局」，艾琳卻回「再麻煩提供餐點品項、
// 取餐時間、外送地址」，什麼都沒抓到。根因：salvage 第一、二輪只認「有明確數量」的
// 寫法（「2個雞胸」「海南雞腿排6盒」），「品項 $價格」這種每行 1 個的團體格式抓不到；
// 「明天11:40」只有 timeStr、沒有 dateStr，進 salvageResult 時被丟掉；
// 「台南市政府交通局」沒有路／街／號關鍵字，地址 fallback 認不得；
// 「共$1675」沒有數量，總額 regex 認不得。
// 客人自算總額 1675 元是錯的：明細合計應為 2575 元（差 900 元＝剛好 6 個海南雞腿排），
// 艾琳要依菜單價重算並糾正（2026-11-17 自動成立流程的設計）。
// 用法：node test-wang-group-order.js
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'dummy';
process.env.BOSS_USER_ID = 'U_boss_test';

const path = require('path');

// ---- 假 LLM：兩種模式 ----
let llmMode = 'parseFailed'; // parseFailed | llm
function fakeChat(history) {
if (llmMode === 'parseFailed') return Promise.resolve({ parseFailed: true});
const last = (history[history.length - 1] || {}).content || '';
if (last.includes('地址在永華路二段100號')) {
return Promise.resolve({ reply: '好的', need_human: false, order: { address: '永華路二段100號', pickup_time: '明天中午11：40'}, customer_note: null});
}
// LLM 正確解析整筆團體訂單（彙整版：同品項合併、備註掛在彙整行上）
return Promise.resolve({
reply: '收到！', need_human: false,
order: {
items: [
{ name: '韓式醬烤梅花豬', qty: 4, note: '半飯'},
{ name: '嫩煎台南虱目魚柳', qty: 3, note: '半飯'},
{ name: '120%元氣雙拼', qty: 1, note: '換地瓜'},
{ name: '海南雞腿排', qty: 6, note: '半飯'},
{ name: '厚切舒肥嫩雞胸', qty: 1, note: null},
{ name: '和風壽喜牛丼', qty: 2, note: null},
{ name: '泰式打拋豬', qty: 1, note: '半飯'},
],
pickup_time: '明天11:40',
name: '王先生',
phone: '0919011000',
address: '台南市政府交通局',
generalNote: null,
customer_total: 1675,
customer_count: null,
},
customer_note: null,
});
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

const { handleMessage, salvage} = require('./lib/handler');

const MSG1 = [
'詮：韓式醬烤梅花豬$135✅',
'芝：嫩煎虱目魚柳$135✅',
'崇：雙拼（雞腿排+梅花豬）飯換地瓜$160✅',
'能：海南雞腿排$150',
'亞：厚切舒肥嫩雞胸$135✅',
'杰：韓式醬烤梅花豬（半飯）$135✅',
'苓：海南雞腿排$150✅',
'涵：海南雞腿排$150✅（半飯）',
'賀：韓式醬烤梅花豬（半飯）$135✅',
'徐：海南雞腿排$150✅',
'健：嫩煎虱目魚柳（半飯）$135✅',
'真：和風壽喜牛肉丼$150✅',
'彤：泰式低脂打拋豬肉（半飯）$135✅',
'煜：和風壽喜牛肉丼$150✅',
'岳：海南雞腿排$150✅',
'榮：韓式醬烤梅花豬、海南雞腿排（半飯）$285✅',
'暉：嫩煎虱目魚柳$135✅',
'———',
'共$1675',
'',
'晚安你好',
'',
'想要請你們外送',
'台南市政府交通局',
'約明天11:40到可以嗎？',
'',
'王先生',
'0919011000',
].join('\n');

const MSG2 = '地址在永華路二段100號明天中午11：40';

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

// 0. salvage 單元：團體格式解析
const s1 = salvage(MSG1);
check('0a salvage 抓到 18 盒', s1.items.reduce((a, i) => a + i.qty, 0) === 18, JSON.stringify(s1.items));
check('0b salvage 梅花豬拆半飯 x2＋原味 x2', s1.items.some((i) => i.name === '韓式醬烤梅花豬' && i.qty === 2 && i.note === '半飯') && s1.items.some((i) => i.name === '韓式醬烤梅花豬' && i.qty === 2 &&!i.note), JSON.stringify(s1.items));
check('0c salvage 海南雞拆半飯 x2＋原味 x4', s1.items.some((i) => i.name === '海南雞腿排' && i.qty === 2 && i.note === '半飯') && s1.items.some((i) => i.name === '海南雞腿排' && i.qty === 4 &&!i.note), JSON.stringify(s1.items));
check('0d salvage 雙拼 x1 飯換地瓜（括號主菜不另計）', s1.items.some((i) => i.name === '120%元氣雙拼' && i.qty === 1 && i.note === '換地瓜'), JSON.stringify(s1.items));
check('0e salvage 地址是台南市政府交通局', s1.address === '台南市政府交通局', JSON.stringify(s1.address));
check('0f salvage 明天＋11:40', s1.dateStr === '明天' && s1.timeStr === '11:40', JSON.stringify({ dateStr: s1.dateStr, timeStr: s1.timeStr}));
check('0g salvage 客人自算總額 1675', s1.customer_total === 1675, JSON.stringify(s1.customer_total));
const s2 = salvage(MSG2);
check('0h salvage 第二則地址乾淨（去在、去時間）', s2.address === '永華路二段100號', JSON.stringify(s2.address));
check('0i salvage 第二則全形冒號時間', s2.dateStr === '明天' && s2.timeStr === '11：40', JSON.stringify({ dateStr: s2.dateStr, timeStr: s2.timeStr}));

// 1. 救援路徑（LLM 解析失敗）：完整團體訂單直接成立，不再問缺的
llmMode = 'parseFailed';
let r = await send('U_wang1', MSG1);
let joined = r.join('\n');
check('1a 救援路徑 直接成立收據', joined.includes('已幫您登記訂單'), joined);
check('1b 救援路徑 不問品項時間地址',!joined.includes('再麻煩提供'), joined);
check('1c 救援路徑 總計 2575', joined.includes('總計 $2575 元'), joined);
check('1d 救援路徑 糾正客人自算 1675', joined.includes('1675 元') && joined.includes('2575 元'), joined);
check('1e 救援路徑 半飯拆開顯示', joined.includes('韓式醬烤梅花豬 x2（半飯）') && joined.includes('海南雞腿排 x2（半飯）') && joined.includes('嫩煎台南虱目魚柳 x1（半飯）'), joined);
check('1f 救援路徑 老闆推播新訂單＋金額更正', pushesToBoss().some((t) => t.includes('') && t.includes('') && t.includes('2575')), JSON.stringify(pushesToBoss()));
check('1g 救援路徑 訂單寫入 1 筆', fakeDb._orders.length === 1, JSON.stringify(fakeDb._orders.length));
check('1h 救援路徑 訂單欄位齊全', (() => { const o = sessions.get('U_wang1').order; return o && o.status === 'confirmed' && o.name === '王先生' && o.phone === '0919011000' && o.address === '台南市政府交通局' && o.pickup_time && o.pickup_time.includes('明天') && o.pickup_time.includes('11:40');})(), JSON.stringify(sessions.get('U_wang1').order));

// 2. 成立後補地址（救援路徑）：改地址＋推播修改，不重複寫檔
r = await send('U_wang1', MSG2);
joined = r.join('\n');
check('2a 補地址 老闆收到訂單修改', pushesToBoss().slice(-1)[0].includes(''), JSON.stringify(pushesToBoss().slice(-1)));
check('2b 補地址 地址已更新', sessions.get('U_wang1').order.address === '永華路二段100號', JSON.stringify(sessions.get('U_wang1').order.address));
check('2c 補地址 不重複寫檔', fakeDb._orders.length === 1, JSON.stringify(fakeDb._orders.length));

// 3. LLM 路徑：LLM 正確解析時也直接成立、總額糾正
llmMode = 'llm';
r = await send('U_wang2', MSG1);
joined = r.join('\n');
check('3a LLM 路徑 直接成立收據', joined.includes('已幫您登記訂單'), joined);
check('3b LLM 路徑 總計 2575＋糾正 1675', joined.includes('總計 $2575 元') && joined.includes('1675 元'), joined);
check('3c LLM 路徑 訂單寫入共 2 筆', fakeDb._orders.length === 2, JSON.stringify(fakeDb._orders.length));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail? 1: 0);
})();
