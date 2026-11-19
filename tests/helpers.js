'use strict';
const EventEmitter = require('events');
const { FileStore } = require('../src/store/file');
const { Engine } = require('../src/engine');

class FakeWA extends EventEmitter {
  constructor() { super(); this.sent = []; this.state = 'open'; }
  getStatus() { return { state: this.state, qr: null, pairingCode: null, me: { id: '966500000000@s.whatsapp.net' }, lastError: '' }; }
  async sendText(jid, text) { this.sent.push({ jid, text }); return 'BOT' + this.sent.length; }
  async presence() {}
  async start() {}
  async stop() {}
  async fetchGroups() { return [{ jid: '1@g.us', name: 'G1', size: 5, isAdmin: true }, { jid: '2@g.us', name: 'G2', size: 9, isAdmin: false }]; }
}

async function makeEngine() {
  const store = new FileStore(null);
  await store.init();
  const wa = new FakeWA();
  const engine = new Engine({ store, wa, config: { secret: 'x'.repeat(40), token: 't'.repeat(40) }, logger: { error() {}, warn() {}, log() {} }, delays: false });
  await engine.init();
  return { engine, store, wa };
}

function incoming(jid, text, extra = {}) {
  return { jid, id: 'M' + Math.random().toString(36).slice(2), fromMe: false, text, hasText: true, kind: 'text', ts: Math.floor(Date.now() / 1000), name: 'أحمد', isGroup: jid.endsWith('@g.us'), participant: '', mentioned: false, quotedMine: false, live: true, ...extra };
}

module.exports = { makeEngine, incoming, FakeWA };
