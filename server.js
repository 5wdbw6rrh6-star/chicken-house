'use strict';
/*
 * سيرفر نظام المطعم - بدون أي مكتبات خارجية (Node.js 16+ فقط)
 * البيانات بتتحفظ في: data/db.json
 *
 * متغيرات البيئة (اختيارية):
 *   PORT          رقم البورت (الافتراضي 3000)
 *   HOST          العنوان (الافتراضي 0.0.0.0)
 *   DATA_DIR      فولدر حفظ البيانات (الافتراضي ./data)
 *   APP_PASSWORD  لو اتحدد، الموقع كله بيطلب كلمة سر (أي اسم مستخدم + كلمة السر)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PASSWORD = process.env.APP_PASSWORD || '';
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const PAY_TYPES = ['cash', 'card', 'wallet'];

/* ---------------- التخزين ---------------- */
function defaults() {
  const menu = [
    ['كشري صغير', 'أطباق', 30], ['كشري كبير', 'أطباق', 45], ['ملوخية بالفراخ', 'أطباق', 85], ['محشي مشكل', 'أطباق', 70],
    ['نصف كيلو كفتة', 'مشويات', 220], ['نصف كيلو كباب', 'مشويات', 280], ['ربع فراخ مشوية', 'مشويات', 95],
    ['شاورما فراخ', 'ساندويتشات', 65], ['ساندويتش فلافل', 'ساندويتشات', 12], ['ساندويتش كبدة', 'ساندويتشات', 40],
    ['شاي', 'مشروبات', 15], ['قهوة تركي', 'مشروبات', 25], ['عصير برتقال', 'مشروبات', 40], ['مياه معدنية', 'مشروبات', 10], ['كولا', 'مشروبات', 20],
    ['أم علي', 'حلويات', 45], ['كنافة', 'حلويات', 40]
  ].map((x, i) => ({ id: i + 1, name: x[0], cat: x[1], price: x[2] }));
  return {
    rev: 1,
    settings: { name: 'مطعم الأصيل', address: 'القاهرة، مصر', phone: '', tax: 14, service: 12, nextNo: 1001 },
    menu, orders: [], entries: [], nextId: 100
  };
}

function writeDb(d) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d));
  fs.renameSync(tmp, DB_FILE); // كتابة آمنة: الملف القديم مبيتلفش لو السيرفر وقف في النص
}

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (d && Array.isArray(d.menu) && d.settings && Array.isArray(d.orders) && Array.isArray(d.entries)) {
      if (typeof d.rev !== 'number') d.rev = 1;
      if (typeof d.nextId !== 'number') d.nextId = 100;
      return d;
    }
    throw new Error('شكل الملف غير صحيح');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      const bak = path.join(DATA_DIR, 'db.corrupt-' + Date.now() + '.json');
      try { fs.copyFileSync(DB_FILE, bak); console.error('db.json تالف، اتحفظت نسخة منه في', bak); } catch (_) {}
    }
    const d = defaults();
    writeDb(d);
    return d;
  }
}

let db = loadDb();
function commit() { db.rev++; writeDb(db); }

/* ---------------- أدوات ---------------- */
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
function fail(status, message) { const e = new Error(message); e.status = status; return e; }
function send(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(fail(413, 'الطلب كبير جداً')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(fail(400, 'بيانات غير صالحة')); }
    });
    req.on('error', reject);
  });
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : NaN);

function authorized(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = crypto.createHash('sha256').update(pass).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ---------------- الـ API ---------------- */
async function handleApi(req, res, p) {
  const m = req.method;

  if (m === 'GET' && p === '/api/data') {
    return send(res, 200, { rev: db.rev, settings: db.settings, menu: db.menu, orders: db.orders, entries: db.entries });
  }

  if (m === 'POST' && p === '/api/orders') {
    const b = await readBody(req);
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 100) throw fail(400, 'الفاتورة فاضية');
    const items = [];
    for (const it of b.items) {
      const dish = db.menu.find((x) => x.id === it.id);
      const qty = Math.floor(num(it.qty));
      if (!dish) throw fail(400, 'فيه صنف اتحذف من القائمة، حدّث الصفحة وجرّب تاني');
      if (!(qty >= 1 && qty <= 999)) throw fail(400, 'كمية غير صحيحة');
      items.push({ name: dish.name, price: dish.price, qty });
    }
    const s = db.settings;
    const sub = r2(items.reduce((a, i) => a + i.price * i.qty, 0));
    const dv = Math.max(0, num(b.discValue) || 0);
    const disc = b.discType === 'amt' ? r2(Math.min(dv, sub)) : r2(sub * Math.min(dv, 100) / 100);
    const base = r2(sub - disc);
    const service = r2(base * s.service / 100);
    const tax = r2((base + service) * s.tax / 100);
    const order = {
      no: s.nextNo++, date: new Date().toISOString(),
      table: str(b.table, 30), pay: PAY_TYPES.includes(b.pay) ? b.pay : 'cash',
      items, subtotal: sub, discount: disc, service, tax, total: r2(base + service + tax),
      shop: { name: s.name, address: s.address, phone: s.phone }
    };
    db.orders.push(order);
    commit();
    return send(res, 201, order);
  }

  if (m === 'POST' && p === '/api/entries') {
    const b = await readBody(req);
    const desc = str(b.desc, 200), amount = num(b.amount);
    if (!desc || !(amount > 0 && amount <= 1e9)) throw fail(400, 'اكتب البيان والمبلغ (أكبر من صفر)');
    const entry = { id: db.nextId++, date: new Date().toISOString(), type: b.type === 'in' ? 'in' : 'out', desc, amount: r2(amount) };
    db.entries.push(entry);
    commit();
    return send(res, 201, entry);
  }

  let mt;
  if (m === 'DELETE' && (mt = p.match(/^\/api\/entries\/(\d+)$/))) {
    const id = +mt[1], n = db.entries.length;
    db.entries = db.entries.filter((e) => e.id !== id);
    if (db.entries.length === n) throw fail(404, 'الحركة غير موجودة');
    commit();
    return send(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/menu') {
    const b = await readBody(req);
    const name = str(b.name, 100), cat = str(b.cat, 50) || 'أخرى', price = num(b.price);
    if (!name || !(price >= 0 && price <= 1e7)) throw fail(400, 'اكتب اسم الصنف وسعره');
    const dish = { id: db.nextId++, name, cat, price: r2(price) };
    db.menu.push(dish);
    commit();
    return send(res, 201, dish);
  }

  if (m === 'DELETE' && (mt = p.match(/^\/api\/menu\/(\d+)$/))) {
    const id = +mt[1], n = db.menu.length;
    db.menu = db.menu.filter((d) => d.id !== id);
    if (db.menu.length === n) throw fail(404, 'الصنف غير موجود');
    commit();
    return send(res, 200, { ok: true });
  }

  if (m === 'PUT' && p === '/api/settings') {
    const b = await readBody(req);
    const tax = num(b.tax), service = num(b.service);
    if (!(tax >= 0 && tax <= 100) || !(service >= 0 && service <= 100)) throw fail(400, 'النسب لازم تكون بين 0 و 100');
    Object.assign(db.settings, {
      name: str(b.name, 100) || 'نظام المطعم', address: str(b.address, 200), phone: str(b.phone, 40), tax, service
    });
    commit();
    return send(res, 200, db.settings);
  }

  throw fail(404, 'غير موجود');
}

/* ---------------- السيرفر ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Restaurant", charset="UTF-8"' });
      return res.end('Unauthorized');
    }
    const p = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(html);
    }
    if (p.startsWith('/api/')) return await handleApi(req, res, p);
    send(res, 404, { error: 'غير موجود' });
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'خطأ داخلي في السيرفر' });
  }
});

server.listen(PORT, HOST, () => {
  console.log('نظام المطعم شغال على http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  console.log('ملف البيانات:', DB_FILE);
  if (!PASSWORD) console.log('تنبيه: مفيش كلمة سر. اضبط APP_PASSWORD قبل ما تنشر الموقع على الإنترنت.');
});
