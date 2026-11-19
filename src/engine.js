'use strict';
const crypto = require('crypto');
const { handleMessage, newState, normDigits } = require('./flow-runner/runner');
const { validateFlow } = require('./flow-runner/validate');
const { defaultFlow } = require('./flow-runner/default-flow');
const sandbox = require('./sandbox/sandbox');
const gemini = require('./ai/gemini');
const { encrypt, decrypt } = require('./crypto');

const DEFAULT_SETTINGS = {
  enabled: true,
  maintenance: false,
  maintenanceText: '🛠️ المساعد في وضع الصيانة حالياً، سنعود قريباً. شكراً لصبرك.',
  ownerName: 'المهندس محمد المجيدي',
  ownerNotifyNumber: '',
  geminiModel: 'gemini-2.5-flash',
  persona:
    'أنت المساعد الشخصي للمهندس محمد المجيدي. تتحدث بالعربية بأسلوب مهذب ومختصر. ' +
    'لا تختلق معلومات عن المهندس، وإذا لم تعرف فاطلب من المراسل ترك رسالة خاصة.',
  takeoverMinutes: 30,
  replyDelayMinMs: 800,
  replyDelayMaxMs: 2500,
  groupCooldownSec: 8,
  retentionDays: 90,
  aiHistoryTurns: 10,
};

const IMPORTANCE = ['high', 'medium', 'low'];
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => crypto.randomBytes(6).toString('hex');
const digits = (s) => String(s || '').replace(/\D/g, '');

class Engine {
  constructor({ store, wa, config, logger, delays = true }) {
    this.store = store;
    this.wa = wa;
    this.config = config;
    this.logger = logger || console;
    this.delays = delays;
    this.startedAt = Date.now();
    this.settings = { ...DEFAULT_SETTINGS };
    this.flow = null;
    this.queues = new Map();
    this.botSent = new Set();
    this.rate = new Map();
    this.lastNotice = new Map();
    this.groupLast = new Map();
    this.schedTimer = null;
    this.sending = false;
  }

  // ---------- lifecycle ----------
  async init() {
    const s = await this.store.get('settings');
    if (s) { try { this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(s) }; } catch { /* keep defaults */ } }
    const f = await this.store.get('flow');
    if (f) { try { this.flow = JSON.parse(f); } catch { this.flow = null; } }
    if (!this.flow || !validateFlow(this.flow).ok) {
      this.flow = defaultFlow();
      await this.store.set('flow', JSON.stringify(this.flow));
    }
    if (this.store.prune) await this.store.prune(this.settings.retentionDays).catch(() => {});

    this.wa.on('message', (m) => this.onMessage(m).catch((e) => this.logger.error('onMessage', e)));
    this.wa.on('chat', ({ jid, patch, soft }) => this.onChat(jid, patch, soft).catch(() => {}));
    this.wa.on('open', () => { this.refreshGroups().catch(() => {}); });
    this.schedTimer = setInterval(() => this.tickBroadcasts().catch((e) => this.logger.error('tick', e)), 15000);
    if (this.schedTimer.unref) this.schedTimer.unref();
    await this.recoverBroadcasts();
  }

  async shutdown() {
    clearInterval(this.schedTimer);
    try { await this.wa.stop(); } catch { /* ignore */ }
  }

  // ---------- settings ----------
  async saveSettings() { await this.store.set('settings', JSON.stringify(this.settings)); }

  publicSettings() {
    const { geminiKeyEnc, ...rest } = this.settings;
    const key = geminiKeyEnc ? decrypt(geminiKeyEnc, this.config.secret) : null;
    return { ...rest, geminiKeySet: !!key, geminiKeyHint: key ? '…' + key.slice(-4) : '' };
  }

  async updateSettings(patch) {
    const p = patch || {};
    const out = {};
    const bool = ['enabled', 'maintenance'];
    const str = ['maintenanceText', 'ownerName', 'geminiModel', 'persona'];
    const num = { takeoverMinutes: [0, 1440], replyDelayMinMs: [0, 20000], replyDelayMaxMs: [0, 30000], groupCooldownSec: [0, 3600], retentionDays: [1, 3650], aiHistoryTurns: [0, 30] };
    bool.forEach((k) => { if (typeof p[k] === 'boolean') out[k] = p[k]; });
    str.forEach((k) => { if (typeof p[k] === 'string') out[k] = p[k].slice(0, 4000); });
    Object.keys(num).forEach((k) => {
      if (p[k] != null && !Number.isNaN(Number(p[k]))) out[k] = Math.min(num[k][1], Math.max(num[k][0], Math.round(Number(p[k]))));
    });
    if (typeof p.ownerNotifyNumber === 'string') {
      const d = digits(p.ownerNotifyNumber);
      if (d && (d.length < 8 || d.length > 15)) throw new Error('رقم التنبيه غير صالح (أرقام فقط مع رمز الدولة)');
      out.ownerNotifyNumber = d;
    }
    if (typeof p.geminiKey === 'string') {
      const k = p.geminiKey.trim();
      if (k === '') out.geminiKeyEnc = '';
      else {
        if (k.length < 20 || /\s/.test(k)) throw new Error('مفتاح Google غير صالح');
        out.geminiKeyEnc = encrypt(k, this.config.secret);
      }
    }
    this.settings = { ...this.settings, ...out };
    await this.saveSettings();
    return this.publicSettings();
  }

  geminiKey() {
    return this.settings.geminiKeyEnc ? decrypt(this.settings.geminiKeyEnc, this.config.secret) : null;
  }

  // ---------- AI ----------
  contactSummary(c) {
    const bits = [];
    if (c.nickname || c.name) bits.push(`اسم المراسل: ${c.nickname || c.name}`);
    Object.entries(c.memory || {}).slice(0, 10).forEach(([k, v]) => bits.push(`${k}: ${v}`));
    return bits.length ? '\n\nمعلومات عن المراسل:\n' + bits.join('\n') : '';
  }

  async aiReply(jid, text, extraSystem = '', contact = {}) {
    const key = this.geminiKey();
    if (!key) throw new Error('مفتاح Google غير مضبوط');
    const hk = `aihist:${jid}`;
    let hist = [];
    try { hist = JSON.parse((await this.store.get(hk)) || '[]'); } catch { hist = []; }
    const turns = this.settings.aiHistoryTurns * 2;
    const answer = await gemini.generate({
      apiKey: key,
      model: this.settings.geminiModel,
      system: this.settings.persona + extraSystem + this.contactSummary(contact),
      history: hist.slice(-turns),
      userText: text,
    });
    hist.push({ role: 'user', text }, { role: 'model', text: answer });
    await this.store.set(hk, JSON.stringify(hist.slice(-Math.max(turns, 2))));
    return answer;
  }

  async testAi() {
    const key = this.geminiKey();
    if (!key) return { ok: false, error: 'مفتاح Google غير مضبوط' };
    try {
      const t = await gemini.generate({ apiKey: key, model: this.settings.geminiModel, userText: 'قل: جاهز', timeoutMs: 15000 });
      return { ok: true, sample: t.slice(0, 80) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------- flow ----------
  async saveFlow(flow) {
    const v = validateFlow(flow);
    if (!v.ok) return { ok: false, ...v };
    this.flow = JSON.parse(JSON.stringify(flow));
    await this.store.set('flow', JSON.stringify(this.flow));
    return { ok: true, ...v };
  }

  async resetFlow() {
    this.flow = defaultFlow();
    await this.store.set('flow', JSON.stringify(this.flow));
    return this.flow;
  }

  async simulate({ flow, state, input, contact }) {
    const f = flow || this.flow;
    const v = validateFlow(f);
    if (!v.ok) return { ok: false, errors: v.errors };
    const c = { name: '', nickname: '', consent: false, memory: {}, ...(contact || {}) };
    const out = await handleMessage({
      flow: f,
      state: state || null,
      contact: c,
      text: input == null ? '' : String(input),
      settings: this.settings,
      hooks: {
        ai: async () => '[هنا يظهر رد الذكاء الاصطناعي في الواقع]',
        saveInbox: async () => {},
      },
    });
    return { ok: true, replies: out.replies, state: out.state, contact: out.contact, effects: out.effects };
  }

  codeReview(code) { return sandbox.review(code); }

  // ---------- contacts ----------
  async getContact(jid) {
    const raw = await this.store.get('contact:' + jid);
    if (raw) { try { return JSON.parse(raw); } catch { /* fallthrough */ } }
    return null;
  }
  async saveContact(c) { await this.store.set('contact:' + c.jid, JSON.stringify(c)); }
  async listContacts() {
    const rows = await this.store.list('contact:');
    const out = [];
    for (const r of rows) { try { out.push(JSON.parse(r.v)); } catch { /* skip */ } }
    return out.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  }
  async updateContact(jid, patch) {
    const c = await this.getContact(jid);
    if (!c) return null;
    ['name', 'nickname', 'notes'].forEach((k) => { if (typeof patch[k] === 'string') c[k] = patch[k].slice(0, 300); });
    if (typeof patch.consent === 'boolean') { c.consent = patch.consent; c.consentAt = Date.now(); }
    if (patch.importance !== undefined) c.importance = IMPORTANCE.includes(patch.importance) ? patch.importance : '';
    if (patch.memory && typeof patch.memory === 'object') {
      const m = {};
      Object.entries(patch.memory).slice(0, 30).forEach(([k, v]) => { if (/^\w{1,30}$/.test(k)) m[k] = String(v).slice(0, 500); });
      c.memory = m;
    }
    await this.saveContact(c);
    return c;
  }
  async deleteContact(jid) {
    await this.store.del('contact:' + jid);
    await this.store.del('state:' + jid);
    await this.store.del('aihist:' + jid);
  }

  // ---------- inbox ----------
  async addInbox(item, contact) {
    const id = `${Date.now()}-${rid()}`;
    const rec = {
      id,
      jid: contact.jid,
      name: contact.nickname || contact.name || '',
      text: String(item.text).slice(0, 2000),
      importance: IMPORTANCE.includes(item.importance) ? item.importance : 'medium',
      ts: now(),
      read: false,
    };
    await this.store.set('inbox:' + id, JSON.stringify(rec));
    const target = digits(this.settings.ownerNotifyNumber);
    if (target) {
      const tag = { high: '🔴 مهمة', medium: '🟠 متوسطة', low: '🟢 غير مهمة' }[rec.importance];
      this.safeSend(`${target}@s.whatsapp.net`, `📩 رسالة خاصة (${tag})\nمن: ${rec.name || contact.jid.split('@')[0]}\n\n${rec.text}`).catch(() => {});
    }
    return rec;
  }
  async listInbox() {
    const rows = await this.store.list('inbox:');
    const out = [];
    for (const r of rows) { try { out.push(JSON.parse(r.v)); } catch { /* skip */ } }
    return out.sort((a, b) => b.ts - a.ts);
  }
  async updateInbox(id, patch) {
    const raw = await this.store.get('inbox:' + id);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (typeof patch.read === 'boolean') rec.read = patch.read;
    await this.store.set('inbox:' + id, JSON.stringify(rec));
    return rec;
  }
  async deleteInbox(id) { await this.store.del('inbox:' + id); }

  // ---------- sending ----------
  async safeSend(jid, text) {
    const id = await this.wa.sendText(jid, text);
    if (id) { this.botSent.add(id); if (this.botSent.size > 500) this.botSent.delete(this.botSent.values().next().value); }
    return id;
  }

  async sendAndStore(jid, text, name = '') {
    const id = await this.safeSend(jid, text);
    const ts = now();
    await this.store.addMessage({ jid, id: id || `out-${ts}-${rid()}`, fromMe: true, text, ts, name });
    await this.store.upsertChat(jid, { lastTs: ts, lastText: text.slice(0, 100) });
    return id;
  }

  async humanDelay(jid) {
    if (!this.delays) return;
    await this.wa.presence(jid, 'composing');
    const { replyDelayMinMs: a, replyDelayMaxMs: b } = this.settings;
    await sleep(a + Math.random() * Math.max(0, b - a));
    await this.wa.presence(jid, 'paused');
  }

  async manualSend(jid, text) {
    const t = String(text || '').trim();
    if (!t) throw new Error('الرسالة فارغة');
    if (!/^[\w.-]+@(s\.whatsapp\.net|g\.us|lid)$/.test(jid)) throw new Error('معرّف المحادثة غير صالح');
    await this.sendAndStore(jid, t.slice(0, 4000));
    return { ok: true };
  }

  async systemSend(to, text) {
    const d = digits(to);
    if (d.length < 8 || d.length > 15) throw new Error('رقم غير صالح');
    await this.safeSend(`${d}@s.whatsapp.net`, text);
    return { ok: true };
  }

  // ---------- incoming ----------
  async onChat(jid, patch, soft) {
    const cur = await this.store.getChat(jid);
    if (soft && cur && cur.name) return;
    await this.store.upsertChat(jid, patch);
  }

  enqueue(jid, fn) {
    const prev = this.queues.get(jid) || Promise.resolve();
    const next = prev.then(fn, fn).catch((e) => this.logger.error('queue', e));
    this.queues.set(jid, next);
    next.then(() => { if (this.queues.get(jid) === next) this.queues.delete(jid); });
    return next;
  }

  async onMessage(m) {
    const stored = await this.store.addMessage({ jid: m.jid, id: m.id, fromMe: m.fromMe, text: m.text, ts: m.ts, kind: m.kind, name: m.fromMe ? '' : m.name });
    const prev = await this.store.getChat(m.jid);
    const patch = { lastTs: Math.max(m.ts, (prev && prev.lastTs) || 0), lastText: m.text.slice(0, 100) };
    if (!m.fromMe && m.name && !m.isGroup && (!prev || !prev.name)) patch.name = m.name;
    if (!m.fromMe && stored && m.live) patch.unread = ((prev && prev.unread) || 0) + 1;
    if (m.fromMe) patch.unread = 0;
    await this.store.upsertChat(m.jid, patch);

    if (!m.live || !stored) return; // history sync or duplicate: never auto-reply
    if (m.fromMe) {
      if (!m.isGroup && !this.botSent.has(m.id) && this.settings.takeoverMinutes > 0) {
        await this.store.upsertChat(m.jid, { pausedUntil: now() + this.settings.takeoverMinutes * 60 });
      }
      return;
    }
    if (!this.settings.enabled) return;
    return this.enqueue(m.jid, () => (m.isGroup ? this.handleGroup(m) : this.handlePrivate(m)));
  }

  rateOk(jid) {
    const t = Date.now();
    const arr = (this.rate.get(jid) || []).filter((x) => t - x < 600000);
    if (arr.length >= 25) { this.rate.set(jid, arr); return false; }
    arr.push(t);
    this.rate.set(jid, arr);
    return true;
  }

  noticeOk(key, ms) {
    const t = Date.now();
    if (t - (this.lastNotice.get(key) || 0) < ms) return false;
    this.lastNotice.set(key, t);
    return true;
  }

  async handlePrivate(m) {
    const jid = m.jid;
    const chat = await this.store.getChat(jid);
    if (chat && chat.pausedUntil > now()) return;
    if (this.settings.maintenance) {
      if (this.noticeOk('maint:' + jid, 1800000)) await this.sendAndStore(jid, this.settings.maintenanceText);
      return;
    }
    if (!this.rateOk(jid)) return;

    let contact = await this.getContact(jid);
    if (!contact) {
      contact = { jid, name: m.name || '', nickname: '', notes: '', consent: false, importance: '', memory: {}, createdAt: Date.now(), lastSeen: 0 };
    }
    contact.lastSeen = Date.now();
    if (!contact.name && m.name) contact.name = m.name;

    if (!m.hasText) {
      if (this.noticeOk('media:' + jid, 600000)) {
        await this.humanDelay(jid);
        await this.sendAndStore(jid, 'عذراً، أستقبل الرسائل النصية فقط حالياً. أرسل 00 للرئيسية.');
      }
      await this.saveContact(contact);
      return;
    }

    let state = null;
    const rawState = await this.store.get('state:' + jid);
    if (rawState) { try { state = JSON.parse(rawState); } catch { state = null; } }

    const out = await handleMessage({
      flow: this.flow,
      state,
      contact,
      text: m.text,
      settings: this.settings,
      hooks: {
        ai: (text, c) => this.aiReply(jid, text, '', c),
        saveInbox: (item, c) => this.addInbox(item, c),
      },
    });
    out.effects.filter((e) => e.type === 'code_error' || e.type === 'ai_error').forEach((e) => this.logger.warn('flow effect', e));

    await this.store.set('state:' + jid, JSON.stringify(out.state));
    await this.saveContact(out.contact);
    for (const text of out.replies) {
      await this.humanDelay(jid);
      await this.sendAndStore(jid, text);
    }
  }

  async handleGroup(m) {
    const g = await this.getGroup(m.jid);
    if (!g || !g.enabled) return;
    if (!m.hasText) return;
    if (this.settings.maintenance) return;
    if (g.mode !== 'all' && !m.mentioned && !m.quotedMine) return;
    const last = this.groupLast.get(m.jid) || 0;
    if (Date.now() - last < this.settings.groupCooldownSec * 1000) return;
    this.groupLast.set(m.jid, Date.now());
    const extra = `\n\nأنت الآن ترد داخل مجموعة واتساب باسم ${g.name || 'المجموعة'} على العملاء. ` + (g.prompt || '') + '\nاجعل ردك قصيراً.';
    try {
      const ans = await this.aiReply(m.jid, m.text, extra, { name: m.name });
      await this.humanDelay(m.jid);
      await this.sendAndStore(m.jid, ans);
    } catch (e) {
      this.logger.warn('group ai failed: ' + e.message);
    }
  }

  // ---------- groups ----------
  async getGroup(jid) {
    const raw = await this.store.get('group:' + jid);
    if (raw) { try { return JSON.parse(raw); } catch { /* fallthrough */ } }
    return null;
  }
  async listGroups() {
    const rows = await this.store.list('group:');
    const out = [];
    for (const r of rows) { try { out.push(JSON.parse(r.v)); } catch { /* skip */ } }
    return out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }
  async refreshGroups() {
    const fresh = await this.wa.fetchGroups();
    for (const g of fresh) {
      const cur = (await this.getGroup(g.jid)) || { enabled: false, mode: 'mention', prompt: '' };
      await this.store.set('group:' + g.jid, JSON.stringify({ ...cur, jid: g.jid, name: g.name, size: g.size, isAdmin: g.isAdmin }));
      await this.store.upsertChat(g.jid, { name: g.name, isGroup: true });
    }
    return fresh.length;
  }
  async updateGroup(jid, patch) {
    const g = await this.getGroup(jid);
    if (!g) return null;
    if (typeof patch.enabled === 'boolean') {
      if (patch.enabled && !g.isAdmin) throw new Error('لا يمكن تفعيل الذكاء الاصطناعي إلا في مجموعة أنت مشرف فيها');
      g.enabled = patch.enabled;
    }
    if (patch.mode === 'all' || patch.mode === 'mention') g.mode = patch.mode;
    if (typeof patch.prompt === 'string') g.prompt = patch.prompt.slice(0, 1500);
    await this.store.set('group:' + jid, JSON.stringify(g));
    return g;
  }

  // ---------- chats ----------
  async updateChat(jid, patch) {
    const p = {};
    if (typeof patch.archived === 'boolean') p.archived = patch.archived;
    if (typeof patch.locked === 'boolean') p.locked = patch.locked;
    if (patch.unread === 0) p.unread = 0;
    if (patch.resumeBot === true) p.pausedUntil = 0;
    return this.store.upsertChat(jid, p);
  }

  // ---------- broadcasts ----------
  async createBroadcast({ text, sendAt, audience, jids }) {
    const t = String(text || '').trim();
    if (!t) throw new Error('نص الإعلان مطلوب');
    if (t.length > 3500) throw new Error('نص الإعلان طويل');
    const when = sendAt ? Math.floor(Number(sendAt)) : now();
    if (!Number.isFinite(when)) throw new Error('وقت غير صالح');
    const aud = audience === 'custom' ? 'custom' : 'consented';
    let list = [];
    if (aud === 'custom') {
      list = (Array.isArray(jids) ? jids : []).filter((j) => /^[\w.-]+@s\.whatsapp\.net$/.test(j)).slice(0, 500);
      if (!list.length) throw new Error('اختر مستلمين');
    }
    const id = `${Date.now()}-${rid()}`;
    const rec = { id, text: t, sendAt: when, audience: aud, jids: list, status: 'scheduled', createdAt: now(), sent: 0, failed: 0, total: 0 };
    await this.store.set('bc:' + id, JSON.stringify(rec));
    return rec;
  }
  async listBroadcasts() {
    const rows = await this.store.list('bc:');
    const out = [];
    for (const r of rows) { try { out.push(JSON.parse(r.v)); } catch { /* skip */ } }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
  async deleteBroadcast(id) {
    const raw = await this.store.get('bc:' + id);
    if (!raw) return false;
    const rec = JSON.parse(raw);
    if (rec.status === 'sending') throw new Error('الإرسال جارٍ');
    await this.store.del('bc:' + id);
    return true;
  }
  async recoverBroadcasts() {
    for (const b of await this.listBroadcasts()) {
      if (b.status === 'sending') { b.status = 'interrupted'; await this.store.set('bc:' + b.id, JSON.stringify(b)); }
    }
  }
  async tickBroadcasts() {
    if (this.sending || this.wa.getStatus().state !== 'open' || this.settings.maintenance) return;
    const due = (await this.listBroadcasts()).filter((b) => b.status === 'scheduled' && b.sendAt <= now()).sort((a, b) => a.sendAt - b.sendAt)[0];
    if (!due) return;
    this.sending = true;
    try { await this.runBroadcast(due); } finally { this.sending = false; }
  }
  async runBroadcast(b) {
    let targets = b.jids;
    if (b.audience === 'consented') targets = (await this.listContacts()).filter((c) => c.consent).map((c) => c.jid);
    b.status = 'sending';
    b.total = targets.length;
    await this.store.set('bc:' + b.id, JSON.stringify(b));
    for (const jid of targets) {
      try {
        await this.sendAndStore(jid, b.text);
        b.sent++;
      } catch (e) {
        b.failed++;
      }
      await this.store.set('bc:' + b.id, JSON.stringify(b));
      if (this.delays) await sleep(4000 + Math.random() * 4000);
    }
    b.status = b.failed && !b.sent ? 'failed' : 'done';
    b.doneAt = now();
    await this.store.set('bc:' + b.id, JSON.stringify(b));
  }

  // ---------- status ----------
  async status() {
    const [contacts, inbox] = await Promise.all([this.listContacts(), this.listInbox()]);
    const chats = await this.store.listChats({ tab: 'all', limit: 500 });
    return {
      version: '1.0.0',
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      wa: this.wa.getStatus(),
      settings: { enabled: this.settings.enabled, maintenance: this.settings.maintenance, geminiKeySet: !!this.settings.geminiKeyEnc },
      counts: { chats: chats.length, contacts: contacts.length, consented: contacts.filter((c) => c.consent).length, inboxUnread: inbox.filter((i) => !i.read).length },
    };
  }
}

module.exports = { Engine, DEFAULT_SETTINGS };
