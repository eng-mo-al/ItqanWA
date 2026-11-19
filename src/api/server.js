'use strict';
const http = require('http');
const { safeEqual } = require('../crypto');

const MAX_BODY = 1024 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('الطلب كبير جداً'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON غير صالح'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function createServer(engine, config) {
  const fails = new Map();

  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  };

  const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  const authorized = (req) => {
    const h = String(req.headers.authorization || '');
    const m = /^Bearer (.+)$/.exec(h);
    return !!m && safeEqual(m[1], config.token);
  };

  const routes = [];
  const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern + '$'), fn });
  const jidOf = (s) => decodeURIComponent(s);
  const ok = (data = {}) => ({ ok: true, ...data });

  on('GET', '/health', async () => ok({ uptime: Math.floor(process.uptime()) }));
  on('GET', '/', async () => ok({ name: 'ItqanWA Engine' }));

  // status & connection
  on('GET', '/status', async () => ok(await engine.status()));
  on('POST', '/wa/start', async ({ body }) => {
    if (body.phone && !/^\d{8,15}$/.test(String(body.phone).replace(/\D/g, ''))) throw Object.assign(new Error('رقم غير صالح'), { status: 400 });
    await engine.wa.start({ phone: body.phone });
    return ok({ wa: engine.wa.getStatus() });
  });
  on('POST', '/wa/stop', async () => { await engine.wa.stop(); return ok(); });
  on('POST', '/wa/logout', async () => { await engine.wa.logout(); return ok(); });

  // settings
  on('GET', '/settings', async () => ok({ settings: engine.publicSettings() }));
  on('PUT', '/settings', async ({ body }) => ok({ settings: await engine.updateSettings(body) }));
  on('POST', '/ai/test', async () => engine.testAi());

  // flow
  on('GET', '/flow', async () => ok({ flow: engine.flow }));
  on('PUT', '/flow', async ({ body }) => {
    const r = await engine.saveFlow(body.flow);
    return r;
  });
  on('POST', '/flow/validate', async ({ body }) => {
    const { validateFlow } = require('../flow-runner/validate');
    return { ok: true, ...validateFlow(body.flow) };
  });
  on('POST', '/flow/simulate', async ({ body }) => engine.simulate(body));
  on('POST', '/flow/reset', async () => ok({ flow: await engine.resetFlow() }));
  on('POST', '/code/test', async ({ body }) => engine.codeReview(String(body.code || '')));

  // chats
  on('GET', '/chats', async ({ query }) => {
    const tab = ['chats', 'groups', 'archived', 'locked'].includes(query.get('tab')) ? query.get('tab') : 'chats';
    return ok({ chats: await engine.store.listChats({ tab, q: query.get('q') || '', limit: 200 }) });
  });
  on('GET', '/chats/([^/]+)/messages', async ({ m, query }) => {
    const limit = Math.min(300, Math.max(1, parseInt(query.get('limit') || '80', 10) || 80));
    return ok({ messages: await engine.store.messages(jidOf(m[1]), { limit }) });
  });
  on('POST', '/chats/([^/]+)/send', async ({ m, body }) => engine.manualSend(jidOf(m[1]), body.text));
  on('PATCH', '/chats/([^/]+)', async ({ m, body }) => ok({ chat: await engine.updateChat(jidOf(m[1]), body) }));

  // groups
  on('GET', '/groups', async () => ok({ groups: await engine.listGroups() }));
  on('POST', '/groups/refresh', async () => { const n = await engine.refreshGroups(); return ok({ count: n, groups: await engine.listGroups() }); });
  on('PATCH', '/groups/([^/]+)', async ({ m, body }) => {
    const g = await engine.updateGroup(jidOf(m[1]), body);
    if (!g) throw Object.assign(new Error('المجموعة غير موجودة'), { status: 404 });
    return ok({ group: g });
  });

  // contacts
  on('GET', '/contacts', async () => ok({ contacts: await engine.listContacts() }));
  on('GET', '/contacts/([^/]+)', async ({ m }) => {
    const c = await engine.getContact(jidOf(m[1]));
    if (!c) throw Object.assign(new Error('غير موجود'), { status: 404 });
    return ok({ contact: c });
  });
  on('PATCH', '/contacts/([^/]+)', async ({ m, body }) => {
    const c = await engine.updateContact(jidOf(m[1]), body);
    if (!c) throw Object.assign(new Error('غير موجود'), { status: 404 });
    return ok({ contact: c });
  });
  on('DELETE', '/contacts/([^/]+)', async ({ m }) => { await engine.deleteContact(jidOf(m[1])); return ok(); });

  // inbox
  on('GET', '/inbox', async () => ok({ items: await engine.listInbox() }));
  on('PATCH', '/inbox/([^/]+)', async ({ m, body }) => {
    const r = await engine.updateInbox(m[1], body);
    if (!r) throw Object.assign(new Error('غير موجود'), { status: 404 });
    return ok({ item: r });
  });
  on('DELETE', '/inbox/([^/]+)', async ({ m }) => { await engine.deleteInbox(m[1]); return ok(); });

  // broadcasts
  on('GET', '/broadcasts', async () => ok({ items: await engine.listBroadcasts() }));
  on('POST', '/broadcasts', async ({ body }) => ok({ item: await engine.createBroadcast(body) }));
  on('DELETE', '/broadcasts/([^/]+)', async ({ m }) => ok({ deleted: await engine.deleteBroadcast(m[1]) }));

  // system
  on('POST', '/system/send', async ({ body }) => engine.systemSend(body.to, String(body.text || '').slice(0, 1000)));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      const route = routes.find((r) => r.method === req.method && r.re.test(pathname));
      if (!route) return send(res, 404, { ok: false, error: 'not found' });

      const open = pathname === '/health' || pathname === '/';
      if (!open) {
        const ip = clientIp(req);
        const rec = fails.get(ip) || { n: 0, t: Date.now() };
        if (Date.now() - rec.t > 60000) { rec.n = 0; rec.t = Date.now(); }
        if (rec.n >= 10) return send(res, 429, { ok: false, error: 'too many attempts' });
        if (!authorized(req)) {
          rec.n++;
          fails.set(ip, rec);
          return send(res, 401, { ok: false, error: 'unauthorized' });
        }
      }
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
      const m = route.re.exec(pathname);
      const out = await route.fn({ req, m, body, query: url.searchParams });
      send(res, 200, out);
    } catch (e) {
      const status = e.status || (e instanceof SyntaxError ? 400 : 400);
      if (!e.status) engine.logger.warn && engine.logger.warn('api error: ' + e.message);
      send(res, status, { ok: false, error: e.message || 'error' });
    }
  });
  server.keepAliveTimeout = 65000;
  return server;
}

module.exports = { createServer };
