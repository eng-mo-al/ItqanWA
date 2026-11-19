'use strict';
const fs = require('fs');
const path = require('path');

const MAX_MSGS_PER_CHAT = 500;

function tabMatch(c, tab) {
  if (tab === 'locked') return !!c.locked;
  if (c.locked) return false;
  if (tab === 'archived') return !!c.archived;
  if (c.archived) return false;
  if (tab === 'groups') return !!c.isGroup;
  if (tab === 'chats') return !c.isGroup;
  return true;
}

class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.file = dir ? path.join(dir, 'store.json') : null;
    this.kv = new Map();
    this.chats = new Map();
    this.msgs = new Map();
    this.timer = null;
  }

  async init() {
    if (!this.file) return;
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.kv = new Map(Object.entries(d.kv || {}));
        this.chats = new Map(Object.entries(d.chats || {}));
        this.msgs = new Map(Object.entries(d.msgs || {}));
      } catch (e) {
        console.error('store file unreadable, starting empty:', e.message);
      }
    }
  }

  _save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 500);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (!this.file) return;
    const data = JSON.stringify({
      kv: Object.fromEntries(this.kv),
      chats: Object.fromEntries(this.chats),
      msgs: Object.fromEntries(this.msgs),
    });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.file);
  }

  async get(k) { return this.kv.has(k) ? this.kv.get(k) : null; }
  async set(k, v) { this.kv.set(k, String(v)); this._save(); }
  async del(k) { this.kv.delete(k); this._save(); }
  async list(prefix) {
    const out = [];
    for (const [k, v] of this.kv) if (k.startsWith(prefix)) out.push({ k, v });
    return out;
  }

  async getChat(jid) { return this.chats.get(jid) || null; }
  async upsertChat(jid, patch) {
    const cur = this.chats.get(jid) || { jid, name: '', isGroup: jid.endsWith('@g.us'), archived: false, locked: false, lastTs: 0, lastText: '', unread: 0, pausedUntil: 0 };
    const next = { ...cur, ...patch, jid };
    this.chats.set(jid, next);
    this._save();
    return next;
  }
  async listChats({ tab, q, limit = 200 } = {}) {
    const needle = (q || '').toLowerCase();
    return [...this.chats.values()]
      .filter((c) => tabMatch(c, tab))
      .filter((c) => !needle || (c.name || '').toLowerCase().includes(needle) || c.jid.includes(needle))
      .sort((a, b) => b.lastTs - a.lastTs)
      .slice(0, limit);
  }

  async addMessage(m) {
    const arr = this.msgs.get(m.jid) || [];
    if (arr.some((x) => x.id === m.id)) return false;
    arr.push({ id: m.id, fromMe: !!m.fromMe, text: m.text || '', ts: m.ts, kind: m.kind || 'text', name: m.name || '' });
    arr.sort((a, b) => a.ts - b.ts);
    while (arr.length > MAX_MSGS_PER_CHAT) arr.shift();
    this.msgs.set(m.jid, arr);
    this._save();
    return true;
  }
  async messages(jid, { limit = 80 } = {}) {
    const arr = this.msgs.get(jid) || [];
    return arr.slice(-limit);
  }

  async prune(days) {
    const cut = Math.floor(Date.now() / 1000) - days * 86400;
    for (const [jid, arr] of this.msgs) this.msgs.set(jid, arr.filter((x) => x.ts >= cut));
    this._save();
  }

  async close() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.flush(); }
}

module.exports = { FileStore, tabMatch };
