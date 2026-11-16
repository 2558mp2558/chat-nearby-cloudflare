// แชตคนใกล้ตัว จังหวัดสมุทรสงคราม - เซิร์ฟเวอร์ Node.js (Node 18+, ไม่ต้องติดตั้งแพ็กเกจเพิ่ม)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ROOMS = ['general', 'checkpoint']; // แชตทั่วไป, ตรวจสอบด่านตรวจในจังหวัด
const MAX_MSGS = 60;      // ข้อความต่อห้อง
const MEDIA_KEEP = 12;    // รูป/เสียงล่าสุดต่อห้องที่เก็บไว้ (เก่ากว่านี้จะหมดอายุ)
const MAX_DM = 1500;      // ข้อความกระซิบทั้งระบบ
const DM_MEDIA_KEEP = 40;
const BAN_MS = 100 * 60 * 1000; // แบน 100 นาที

let store = { general: [], checkpoint: [] };
let dms = [];
const profiles = new Map(); // id -> {n, pic, pv}
const bans = new Map();     // id -> เวลาที่แบนสิ้นสุด
const people = new Map();   // id -> {n, d, adm, ts} (ผู้ออนไลน์)
const clients = new Set();  // {res, id, admin}
const lastSend = new Map(); // key -> เวลาที่ส่งล่าสุด

try {
  const x = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  for (const r of ROOMS) if (x.store && Array.isArray(x.store[r])) store[r] = x.store[r];
  if (Array.isArray(x.dms)) dms = x.dms;
  for (const [k, v] of x.profiles || []) profiles.set(k, v);
  for (const [k, v] of x.bans || []) bans.set(k, v);
} catch (e) {}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = { store, dms, profiles: [...profiles], bans: [...bans] };
    fs.writeFile(DATA_FILE, JSON.stringify(out), () => {});
  }, 2000);
}

// ---------- ตัวช่วย ----------
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const validD = (d) => Number.isInteger(d) && d >= 0 && d <= 2;
const HEX16 = /^[0-9a-f]{16}$/;
function idOf(tk) {
  if (typeof tk !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(tk)) return null;
  return sha(tk).toString('hex').slice(0, 16);
}
function isAdmin(ak) {
  if (!ADMIN_KEY || typeof ak !== 'string') return false;
  return crypto.timingSafeEqual(sha(ak), sha(ADMIN_KEY));
}
function activeBan(id) {
  const u = bans.get(id);
  if (u && u > Date.now()) return u;
  if (u) { bans.delete(id); save(); }
  return 0;
}
function activeBans() {
  const o = {}, now = Date.now();
  for (const [k, v] of bans) if (v > now) o[k] = v;
  return o;
}
function peopleList() {
  const now = Date.now();
  for (const [k, v] of people) if (now - v.ts > 90000) people.delete(k);
  return [...people].map(([id, v]) => ({ id, n: v.n, d: v.d, adm: v.adm ? 1 : 0, pv: (profiles.get(id) || {}).pv || 0 }));
}
function sse(res, ev, data) { res.write('event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n'); }
function bcast(ev, data) { for (const c of clients) sse(c.res, ev, data); }
let pt = null;
function bpeople() { if (pt) return; pt = setTimeout(() => { pt = null; bcast('people', peopleList()); }, 800); }
function sendBansToAdmins() { const b = activeBans(); for (const c of clients) if (c.admin) sse(c.res, 'bans', b); }
function myDms(id) { return dms.filter((m) => m.a === id || m.b === id).slice(-300); }
function stripMedia(arr, keep) {
  let n = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (m.im || m.au) { n++; if (n > keep) { delete m.im; delete m.au; m.exp = 1; } }
  }
}
function limited(id, ip, media) {
  const gap = media ? 4000 : 1200, now = Date.now();
  for (const k of ['id:' + id, 'ip:' + ip]) if (now - (lastSend.get(k) || 0) < gap) return true;
  lastSend.set('id:' + id, now); lastSend.set('ip:' + ip, now);
  return false;
}
// ตรวจเนื้อหาข้อความ (ข้อความ / เสียง / รูป)
function content(b) {
  const k = b.k === 'v' || b.k === 'i' ? b.k : 't';
  const o = { k };
  if (k === 't') { o.t = clean(b.t, 200); if (!o.t) return null; }
  else if (k === 'v') {
    if (typeof b.au !== 'string' || !/^data:audio\/[a-z0-9.+-]+[;,]/i.test(b.au) || b.au.length > 230000) return null;
    o.au = b.au; o.dur = Math.min(15, Math.max(1, parseInt(b.dur, 10) || 1)); o.t = '🎙️ ข้อความเสียง';
  } else {
    if (typeof b.im !== 'string' || !/^data:image\/(jpeg|png|webp|gif);base64,/i.test(b.im) || b.im.length > 200000) return null;
    o.im = b.im; o.t = '🖼️ รูปภาพ';
  }
  return o;
}
function readBody(req) {
  return new Promise((ok, no) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 330000) { req.destroy(); no(); } });
    req.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { no(); } });
  });
}
const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

// ---------- เซิร์ฟเวอร์ ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); return res.end('index.html not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }

  if (req.method === 'GET' && p.startsWith('/pic/')) {
    const id = p.slice(5);
    const pr = HEX16.test(id) && profiles.get(id);
    if (!pr || !pr.pic) { res.writeHead(404); return res.end(); }
    const m = /^data:(image\/[a-z]+);base64,(.*)$/s.exec(pr.pic);
    if (!m) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=300' });
    return res.end(Buffer.from(m[2], 'base64'));
  }

  if (req.method === 'GET' && p === '/events') {
    const id = idOf(u.searchParams.get('tk'));
    if (!id) { res.writeHead(400); return res.end('bad token'); }
    const admin = isAdmin(u.searchParams.get('ak'));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const c = { res, id, admin };
    sse(res, 'init', {
      me: { id, admin, ban: activeBan(id), pv: (profiles.get(id) || {}).pv || 0 },
      msgs: store, people: peopleList(), dms: myDms(id), bans: admin ? activeBans() : {},
    });
    clients.add(c);
    req.on('close', () => clients.delete(c));
    return;
  }

  if (req.method !== 'POST') { res.writeHead(404); return res.end('Not found'); }

  let b;
  try { b = await readBody(req); } catch (e) { return json(res, 400, { ok: false }); }
  const id = idOf(b.tk);
  if (!id) return json(res, 400, { ok: false });
  const admin = isAdmin(b.ak);
  const ip = ipOf(req);

  if (p === '/api/presence') {
    const n = clean(b.n, 12);
    if (!n || !validD(b.d)) return json(res, 400, { ok: false });
    people.set(id, { n, d: b.d, adm: admin, ts: Date.now() });
    const old = profiles.get(id) || {};
    profiles.set(id, { n, pic: old.pic, pv: old.pv || 0 });
    bpeople(); save();
    return json(res, 200, { ok: true, pv: old.pv || 0 });
  }

  if (p === '/api/pic') {
    if (typeof b.pic !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(b.pic) || b.pic.length > 60000)
      return json(res, 400, { ok: false });
    const old = profiles.get(id) || { n: 'ผู้ใช้' };
    const pv = Date.now();
    profiles.set(id, { n: old.n, pic: b.pic, pv });
    bpeople(); save();
    return json(res, 200, { ok: true, pv });
  }

  if (p === '/api/send') {
    const n = clean(b.n, 12), r = clean(b.r, 20), c = content(b);
    if (!n || !c || !validD(b.d) || !ROOMS.includes(r)) return json(res, 400, { ok: false });
    const ban = activeBan(id);
    if (ban && !admin) return json(res, 403, { ok: false, error: 'banned', until: ban });
    if (limited(id, ip, c.k !== 't')) return json(res, 429, { ok: false });
    const m = Object.assign({ u: id, n, d: b.d, r, ts: Date.now(), pv: (profiles.get(id) || {}).pv || 0 }, c);
    if (admin) m.adm = 1;
    store[r].push(m);
    if (store[r].length > MAX_MSGS) store[r] = store[r].slice(-MAX_MSGS);
    stripMedia(store[r], MEDIA_KEEP);
    save(); bcast('msg', m);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/dm') {
    const n = clean(b.n, 12), to = String(b.to || ''), c = content(b);
    if (!n || !c || !HEX16.test(to) || to === id || !(profiles.has(to) || people.has(to))) return json(res, 400, { ok: false });
    const ban = activeBan(id);
    if (ban && !admin) return json(res, 403, { ok: false, error: 'banned', until: ban });
    if (limited(id, ip, c.k !== 't')) return json(res, 429, { ok: false });
    const m = Object.assign({ a: id, an: n, b: to, ts: Date.now(), pv: (profiles.get(id) || {}).pv || 0 }, c);
    if (admin) m.adm = 1;
    dms.push(m);
    if (dms.length > MAX_DM) dms = dms.slice(-MAX_DM);
    stripMedia(dms, DM_MEDIA_KEEP);
    save();
    for (const cl of clients) if (cl.id === id || cl.id === to) sse(cl.res, 'dm', m);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/ban') {
    if (!admin) return json(res, 403, { ok: false });
    const target = String(b.target || '');
    if (!HEX16.test(target) || target === id) return json(res, 400, { ok: false });
    for (const cl of clients) if (cl.id === target && cl.admin) return json(res, 400, { ok: false });
    let until = 0;
    if (Number(b.mins) > 0) { until = Date.now() + BAN_MS; bans.set(target, until); } else bans.delete(target);
    save();
    for (const cl of clients) if (cl.id === target) sse(cl.res, 'ban', { until });
    sendBansToAdmins();
    return json(res, 200, { ok: true, until });
  }

  res.writeHead(404); res.end('Not found');
});

setInterval(() => { bcast('people', peopleList()); for (const c of clients) c.res.write(': ping\n\n'); }, 20000);
setInterval(() => { const x = Date.now() - 60000; for (const [k, v] of lastSend) if (v < x) lastSend.delete(k); }, 60000);

if (!ADMIN_KEY) console.log('คำเตือน: ยังไม่ได้ตั้งค่า ADMIN_KEY จึงใช้ฟีเจอร์แอดมิน (ชื่อสีแดง/แบน) ไม่ได้');
server.listen(PORT, () => console.log('เปิดที่ http://localhost:' + PORT));
