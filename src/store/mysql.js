'use strict';

const DEFAULT_CHAT = { name: '', isGroup: false, archived: false, locked: false, lastTs: 0, lastText: '', unread: 0, pausedUntil: 0 };

class MySqlStore {
  constructor(url, ssl) {
    this.url = url;
    this.ssl = ssl;
    this.pool = null;
  }

  async init() {
    const mysql = require('mysql2/promise');
    const u = new URL(this.url);
    const local = ['localhost', '127.0.0.1'].includes(u.hostname);
    const useSsl = this.ssl === null ? !local : this.ssl;
    this.pool = mysql.createPool({
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ''),
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: 5,
      ssl: useSsl ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
    });
    const q = (s) => this.pool.query(s);
    await q(`CREATE TABLE IF NOT EXISTS kv (
      k VARCHAR(190) NOT NULL PRIMARY KEY,
      v LONGTEXT NOT NULL,
      updated BIGINT NOT NULL
    ) DEFAULT CHARSET=utf8mb4`);
    await q(`CREATE TABLE IF NOT EXISTS chats (
      jid VARCHAR(100) NOT NULL PRIMARY KEY,
      is_group TINYINT NOT NULL DEFAULT 0,
      archived TINYINT NOT NULL DEFAULT 0,
      locked TINYINT NOT NULL DEFAULT 0,
      last_ts BIGINT NOT NULL DEFAULT 0,
      data TEXT NOT NULL,
      KEY idx_tab (locked, archived, is_group, last_ts)
    ) DEFAULT CHARSET=utf8mb4`);
    await q(`CREATE TABLE IF NOT EXISTS messages (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      jid VARCHAR(100) NOT NULL,
      msg_id VARCHAR(100) NOT NULL,
      from_me TINYINT NOT NULL DEFAULT 0,
      text TEXT NOT NULL,
      ts BIGINT NOT NULL,
      kind VARCHAR(20) NOT NULL DEFAULT 'text',
      name VARCHAR(120) NOT NULL DEFAULT '',
      UNIQUE KEY uq_msg (jid, msg_id),
      KEY idx_jid (jid, ts)
    ) DEFAULT CHARSET=utf8mb4`);
  }

  async get(k) {
    const [rows] = await this.pool.query('SELECT v FROM kv WHERE k = ?', [k]);
    return rows.length ? rows[0].v : null;
  }
  async set(k, v) {
    await this.pool.query(
      'INSERT INTO kv (k, v, updated) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v), updated = VALUES(updated)',
      [k, String(v), Date.now()]
    );
  }
  async del(k) { await this.pool.query('DELETE FROM kv WHERE k = ?', [k]); }
  async list(prefix) {
    const esc = prefix.replace(/[\\%_]/g, (c) => '\\' + c);
    const [rows] = await this.pool.query('SELECT k, v FROM kv WHERE k LIKE ?', [esc + '%']);
    return rows.map((r) => ({ k: r.k, v: r.v }));
  }

  async getChat(jid) {
    const [rows] = await this.pool.query('SELECT data FROM chats WHERE jid = ?', [jid]);
    if (!rows.length) return null;
    try { return { jid, ...DEFAULT_CHAT, ...JSON.parse(rows[0].data) }; } catch { return null; }
  }
  async upsertChat(jid, patch) {
    const cur = (await this.getChat(jid)) || { jid, ...DEFAULT_CHAT, isGroup: jid.endsWith('@g.us') };
    const next = { ...cur, ...patch, jid };
    await this.pool.query(
      `INSERT INTO chats (jid, is_group, archived, locked, last_ts, data) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE is_group = VALUES(is_group), archived = VALUES(archived), locked = VALUES(locked), last_ts = VALUES(last_ts), data = VALUES(data)`,
      [jid, next.isGroup ? 1 : 0, next.archived ? 1 : 0, next.locked ? 1 : 0, next.lastTs || 0, JSON.stringify(next)]
    );
    return next;
  }
  async listChats({ tab, q, limit = 200 } = {}) {
    let where = '1=1';
    if (tab === 'locked') where = 'locked = 1';
    else if (tab === 'archived') where = 'locked = 0 AND archived = 1';
    else if (tab === 'groups') where = 'locked = 0 AND archived = 0 AND is_group = 1';
    else if (tab === 'chats') where = 'locked = 0 AND archived = 0 AND is_group = 0';
    const [rows] = await this.pool.query(`SELECT jid, data FROM chats WHERE ${where} ORDER BY last_ts DESC LIMIT ?`, [Math.min(limit, 500)]);
    const needle = (q || '').toLowerCase();
    const out = [];
    for (const r of rows) {
      let c;
      try { c = { jid: r.jid, ...DEFAULT_CHAT, ...JSON.parse(r.data) }; } catch { continue; }
      if (needle && !(c.name || '').toLowerCase().includes(needle) && !c.jid.includes(needle)) continue;
      out.push(c);
    }
    return out;
  }

  async addMessage(m) {
    const [res] = await this.pool.query(
      'INSERT IGNORE INTO messages (jid, msg_id, from_me, text, ts, kind, name) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [m.jid, String(m.id).slice(0, 100), m.fromMe ? 1 : 0, (m.text || '').slice(0, 20000), m.ts, m.kind || 'text', (m.name || '').slice(0, 120)]
    );
    return res.affectedRows > 0;
  }
  async messages(jid, { limit = 80 } = {}) {
    const [rows] = await this.pool.query(
      'SELECT msg_id, from_me, text, ts, kind, name FROM messages WHERE jid = ? ORDER BY ts DESC, id DESC LIMIT ?',
      [jid, Math.min(limit, 300)]
    );
    return rows.reverse().map((r) => ({ id: r.msg_id, fromMe: !!r.from_me, text: r.text, ts: Number(r.ts), kind: r.kind, name: r.name }));
  }
  async prune(days) {
    const cut = Math.floor(Date.now() / 1000) - days * 86400;
    await this.pool.query('DELETE FROM messages WHERE ts < ?', [cut]);
  }
  async close() { if (this.pool) await this.pool.end(); }
}

module.exports = { MySqlStore };
