'use strict';
const EventEmitter = require('events');
const pino = require('pino');
const { useStoreAuthState } = require('./auth-state');

const IGNORED_SUFFIX = ['@broadcast', '@newsletter'];

function bare(jid) {
  return String(jid || '').replace(/:\d+(?=@)/, '');
}

function unwrap(message) {
  let x = message;
  for (let i = 0; i < 5 && x; i++) {
    if (x.ephemeralMessage) x = x.ephemeralMessage.message;
    else if (x.viewOnceMessage) x = x.viewOnceMessage.message;
    else if (x.viewOnceMessageV2) x = x.viewOnceMessageV2.message;
    else if (x.documentWithCaptionMessage) x = x.documentWithCaptionMessage.message;
    else break;
  }
  return x || {};
}

function extract(message) {
  const x = unwrap(message);
  const text =
    x.conversation ||
    (x.extendedTextMessage && x.extendedTextMessage.text) ||
    (x.imageMessage && x.imageMessage.caption) ||
    (x.videoMessage && x.videoMessage.caption) ||
    (x.buttonsResponseMessage && x.buttonsResponseMessage.selectedDisplayText) ||
    (x.listResponseMessage && x.listResponseMessage.title) ||
    (x.templateButtonReplyMessage && x.templateButtonReplyMessage.selectedDisplayText) ||
    '';
  let kind = 'text';
  if (!text) {
    if (x.imageMessage) kind = 'image';
    else if (x.videoMessage) kind = 'video';
    else if (x.audioMessage) kind = 'audio';
    else if (x.documentMessage) kind = 'document';
    else if (x.stickerMessage) kind = 'sticker';
    else if (x.locationMessage) kind = 'location';
    else if (x.contactMessage) kind = 'contact';
    else kind = 'other';
  }
  const ctx = (x.extendedTextMessage && x.extendedTextMessage.contextInfo) || (x.imageMessage && x.imageMessage.contextInfo) || {};
  return { text, kind, mentioned: ctx.mentionedJid || [], quotedParticipant: ctx.participant || '' };
}

const PLACEHOLDER = { image: '[صورة]', video: '[فيديو]', audio: '[رسالة صوتية]', document: '[ملف]', sticker: '[ملصق]', location: '[موقع]', contact: '[جهة اتصال]', other: '[رسالة غير نصية]' };

class WhatsAppConnection extends EventEmitter {
  constructor({ store, logger }) {
    super();
    this.store = store;
    this.logger = logger || pino({ level: 'warn' });
    this.sock = null;
    this.state = 'idle'; // idle | connecting | qr | open | closed | replaced
    this.qr = null;
    this.pairingCode = null;
    this.pairPhone = null;
    this.lastError = '';
    this.me = null;
    this.retries = 0;
    this.wantRun = false;
    this.auth = null;
    this.B = null;
    this.timer = null;
  }

  async _load() {
    if (this.B) return this.B;
    const mod = await import('@whiskeysockets/baileys');
    const root = mod.default && typeof mod.default === 'object' ? mod.default : mod;
    const pick = (n) => (mod[n] !== undefined ? mod[n] : root[n]);
    this.B = {
      makeWASocket: typeof mod.default === 'function' ? mod.default : root.default || pick('makeWASocket'),
      DisconnectReason: pick('DisconnectReason'),
      fetchLatestBaileysVersion: pick('fetchLatestBaileysVersion'),
      Browsers: pick('Browsers'),
      BufferJSON: pick('BufferJSON'),
      initAuthCreds: pick('initAuthCreds'),
      proto: pick('proto'),
      makeCacheableSignalKeyStore: pick('makeCacheableSignalKeyStore'),
    };
    if (typeof this.B.makeWASocket !== 'function') throw new Error('Baileys: makeWASocket not found');
    return this.B;
  }

  getStatus() {
    return { state: this.state, qr: this.qr, pairingCode: this.pairingCode, me: this.me, lastError: this.lastError };
  }

  ownIds() {
    const ids = new Set();
    if (this.sock && this.sock.user) {
      if (this.sock.user.id) ids.add(bare(this.sock.user.id));
      if (this.sock.user.lid) ids.add(bare(this.sock.user.lid));
    }
    return ids;
  }

  async hasSavedSession() {
    return !!(await this.store.get('auth:creds'));
  }

  async start(opts = {}) {
    if (opts.phone) this.pairPhone = String(opts.phone).replace(/\D/g, '');
    this.wantRun = true;
    if (this.sock || this.state === 'connecting') return;
    await this._connect();
  }

  async _connect() {
    clearTimeout(this.timer);
    const B = await this._load();
    this.auth = await useStoreAuthState(this.store, B);
    let version;
    try { version = (await B.fetchLatestBaileysVersion()).version; } catch { /* use bundled default */ }
    this.state = 'connecting';
    this.qr = null;
    this.lastError = '';

    const sock = B.makeWASocket({
      ...(version ? { version } : {}),
      auth: {
        creds: this.auth.state.creds,
        keys: B.makeCacheableSignalKeyStore ? B.makeCacheableSignalKeyStore(this.auth.state.keys, this.logger) : this.auth.state.keys,
      },
      logger: this.logger,
      browser: B.Browsers && B.Browsers.macOS ? B.Browsers.macOS('Desktop') : ['ItqanWA', 'Chrome', '1.0'],
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async () => undefined,
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => this.auth.saveCreds().catch((e) => this.logger.error(e, 'saveCreds')));

    sock.ev.on('connection.update', async (u) => {
      try {
        if (u.qr) {
          this.state = 'qr';
          try {
            const QR = require('qrcode');
            this.qr = await QR.toDataURL(u.qr, { margin: 1, width: 320 });
          } catch { this.qr = null; }
          if (this.pairPhone && !sock.authState.creds.registered && !this.pairingCode) {
            try { this.pairingCode = await sock.requestPairingCode(this.pairPhone); } catch (e) { this.lastError = 'pairing: ' + e.message; }
          }
        }
        if (u.connection === 'open') {
          this.state = 'open';
          this.qr = null;
          this.pairingCode = null;
          this.retries = 0;
          this.me = { id: bare(sock.user && sock.user.id), name: (sock.user && sock.user.name) || '' };
          this.emit('open', this.me);
        }
        if (u.connection === 'close') {
          const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
          this.sock = null;
          this.me = null;
          this.qr = null;
          this.lastError = (u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.message) || '';
          const DR = B.DisconnectReason || {};
          if (code === DR.loggedOut) {
            await this.auth.clear();
            this.state = 'closed';
            this.wantRun = false;
            this.emit('close', { reason: 'loggedOut' });
          } else if (code === DR.connectionReplaced) {
            this.state = 'replaced';
            this.wantRun = false;
            this.emit('close', { reason: 'replaced' });
          } else if (this.wantRun) {
            this.state = 'connecting';
            const wait = code === DR.restartRequired ? 500 : Math.min(30000, 1000 * 2 ** Math.min(this.retries++, 5));
            this.timer = setTimeout(() => this._connect().catch((e) => { this.lastError = e.message; this.state = 'closed'; }), wait);
          } else {
            this.state = 'idle';
          }
        }
      } catch (e) {
        this.logger.error(e, 'connection.update');
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages || []) {
        try {
          const jid = m.key && m.key.remoteJid;
          if (!jid || IGNORED_SUFFIX.some((s) => jid.endsWith(s)) || jid === 'status@broadcast') continue;
          if (!m.message) continue;
          const info = extract(m.message);
          const own = this.ownIds();
          const mentioned = info.mentioned.some((j) => own.has(bare(j)));
          const quotedMine = !!info.quotedParticipant && own.has(bare(info.quotedParticipant));
          this.emit('message', {
            jid,
            id: m.key.id,
            fromMe: !!m.key.fromMe,
            text: info.text || PLACEHOLDER[info.kind] || '',
            hasText: !!info.text,
            kind: info.kind,
            ts: Number(m.messageTimestamp && m.messageTimestamp.toNumber ? m.messageTimestamp.toNumber() : m.messageTimestamp) || Math.floor(Date.now() / 1000),
            name: m.pushName || '',
            isGroup: jid.endsWith('@g.us'),
            participant: m.key.participant || '',
            mentioned,
            quotedMine,
            live: type === 'notify',
          });
        } catch (e) {
          this.logger.error(e, 'message parse');
        }
      }
    });

    const chatPatch = (c) => {
      if (!c || !c.id || IGNORED_SUFFIX.some((s) => c.id.endsWith(s)) || c.id === 'status@broadcast') return;
      const patch = {};
      if (c.name) patch.name = c.name;
      if (typeof c.archived === 'boolean') patch.archived = c.archived;
      if (Object.keys(patch).length) this.emit('chat', { jid: c.id, patch });
    };
    sock.ev.on('chats.upsert', (list) => (list || []).forEach(chatPatch));
    sock.ev.on('chats.update', (list) => (list || []).forEach(chatPatch));
    sock.ev.on('messaging-history.set', ({ chats }) => (chats || []).forEach(chatPatch));
    sock.ev.on('contacts.upsert', (list) => (list || []).forEach((c) => { if (c.id && (c.name || c.notify)) this.emit('chat', { jid: c.id, patch: { name: c.name || c.notify }, soft: true }); }));
  }

  async stop() {
    this.wantRun = false;
    clearTimeout(this.timer);
    const s = this.sock;
    this.sock = null;
    if (s) { try { s.end(undefined); } catch { /* ignore */ } }
    this.state = 'idle';
    this.qr = null;
  }

  async logout() {
    const s = this.sock;
    this.wantRun = false;
    clearTimeout(this.timer);
    if (s) { try { await s.logout(); } catch { /* ignore */ } }
    this.sock = null;
    const B = await this._load();
    const a = await useStoreAuthState(this.store, B);
    await a.clear();
    this.state = 'closed';
    this.me = null;
    this.qr = null;
  }

  _need() {
    if (!this.sock || this.state !== 'open') throw new Error('واتساب غير متصل');
    return this.sock;
  }

  async sendText(jid, text) {
    const sock = this._need();
    const res = await sock.sendMessage(jid, { text: String(text).slice(0, 4000) });
    return res && res.key && res.key.id;
  }

  async presence(jid, type = 'composing') {
    try { await this._need().sendPresenceUpdate(type, jid); } catch { /* ignore */ }
  }

  async fetchGroups() {
    const sock = this._need();
    const all = await sock.groupFetchAllParticipating();
    const own = this.ownIds();
    return Object.values(all).map((g) => {
      const me = (g.participants || []).find((p) => own.has(bare(p.id)) || own.has(bare(p.lid || '')) || own.has(bare(p.phoneNumber || '')));
      return {
        jid: g.id,
        name: g.subject || '',
        size: (g.participants || []).length,
        isAdmin: !!(me && (me.admin === 'admin' || me.admin === 'superadmin')),
      };
    });
  }
}

module.exports = { WhatsAppConnection, extract, bare };
