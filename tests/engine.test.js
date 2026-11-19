'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { makeEngine, incoming } = require('./helpers');
const { createServer } = require('../src/api/server');
const { FileStore } = require('../src/store/file');

const J = '966511111111@s.whatsapp.net';

test('private conversation end to end', async () => {
  const { engine, wa, store } = await makeEngine();
  await engine.onMessage(incoming(J, 'مرحبا'));
  assert.match(wa.sent[0].text, /المساعد الشخصي/);
  await engine.onMessage(incoming(J, '3'));
  await engine.onMessage(incoming(J, 'رسالة مهمة'));
  await engine.onMessage(incoming(J, '1'));
  const inbox = await engine.listInbox();
  assert.strictEqual(inbox.length, 1);
  assert.strictEqual(inbox[0].importance, 'high');
  const contact = await engine.getContact(J);
  assert.strictEqual(contact.name, 'أحمد');
  const chats = await store.listChats({ tab: 'chats' });
  assert.strictEqual(chats.length, 1);
  const msgs = await store.messages(J, {});
  assert.ok(msgs.some((m) => m.fromMe) && msgs.some((m) => !m.fromMe));
});

test('history sync messages never trigger replies', async () => {
  const { engine, wa } = await makeEngine();
  await engine.onMessage(incoming(J, 'old', { live: false }));
  assert.strictEqual(wa.sent.length, 0);
});

test('duplicate message id is ignored', async () => {
  const { engine, wa } = await makeEngine();
  const m = incoming(J, 'hi');
  await engine.onMessage(m);
  const n = wa.sent.length;
  await engine.onMessage(m);
  assert.strictEqual(wa.sent.length, n);
});

test('disabled and maintenance modes', async () => {
  const { engine, wa } = await makeEngine();
  await engine.updateSettings({ enabled: false });
  await engine.onMessage(incoming(J, 'hi'));
  assert.strictEqual(wa.sent.length, 0);
  await engine.updateSettings({ enabled: true, maintenance: true });
  await engine.onMessage(incoming(J, 'hi'));
  assert.match(wa.sent[0].text, /الصيانة/);
  await engine.onMessage(incoming(J, 'hi again'));
  assert.strictEqual(wa.sent.length, 1);
});

test('owner typing from phone pauses bot', async () => {
  const { engine, wa } = await makeEngine();
  await engine.onMessage(incoming(J, 'hi', { fromMe: true, id: 'HUMAN1' }));
  await engine.onMessage(incoming(J, 'hello'));
  assert.strictEqual(wa.sent.length, 0);
  await engine.updateChat(J, { resumeBot: true });
  await engine.onMessage(incoming(J, 'hello2'));
  assert.ok(wa.sent.length > 0);
});

test('media message gets one notice only', async () => {
  const { engine, wa } = await makeEngine();
  await engine.onMessage(incoming(J, '[صورة]', { hasText: false, kind: 'image' }));
  await engine.onMessage(incoming(J, '[صورة]', { hasText: false, kind: 'image' }));
  assert.strictEqual(wa.sent.length, 1);
});

test('settings: key encrypted, hidden, validated', async () => {
  const { engine, store } = await makeEngine();
  const pub = await engine.updateSettings({ geminiKey: 'AQ.Ab8RN6LEk_fake_test_key_1234567', ownerNotifyNumber: '+966 5 0000 0000' });
  assert.strictEqual(pub.geminiKeySet, true);
  assert.strictEqual(pub.geminiKeyHint, '…4567');
  assert.ok(!('geminiKeyEnc' in pub) && !('geminiKey' in pub));
  assert.ok(!(await store.get('settings')).includes('fake_test_key'));
  assert.strictEqual(engine.geminiKey(), 'AQ.Ab8RN6LEk_fake_test_key_1234567');
  assert.strictEqual(pub.ownerNotifyNumber, '966500000000');
  await assert.rejects(engine.updateSettings({ geminiKey: 'short' }));
  await assert.rejects(engine.updateSettings({ ownerNotifyNumber: '123' }));
});

test('groups: only admin groups can be enabled; replies on mention', async () => {
  const { engine, wa } = await makeEngine();
  await engine.refreshGroups();
  await assert.rejects(engine.updateGroup('2@g.us', { enabled: true }));
  await engine.updateGroup('1@g.us', { enabled: true });
  engine.aiReply = async () => 'رد المجموعة';
  await engine.onMessage(incoming('1@g.us', 'سؤال بلا ذكر', { participant: 'x@s.whatsapp.net' }));
  assert.strictEqual(wa.sent.length, 0);
  await engine.onMessage(incoming('1@g.us', 'سؤال', { mentioned: true, participant: 'x@s.whatsapp.net' }));
  assert.strictEqual(wa.sent.length, 1);
  assert.strictEqual(wa.sent[0].text, 'رد المجموعة');
});

test('chat tabs: archived, locked, groups', async () => {
  const { engine, store } = await makeEngine();
  await engine.onMessage(incoming(J, 'hi'));
  await engine.refreshGroups();
  assert.strictEqual((await store.listChats({ tab: 'groups' })).length, 2);
  await engine.updateChat(J, { archived: true });
  assert.strictEqual((await store.listChats({ tab: 'chats' })).length, 0);
  assert.strictEqual((await store.listChats({ tab: 'archived' })).length, 1);
  await engine.updateChat(J, { locked: true });
  assert.strictEqual((await store.listChats({ tab: 'archived' })).length, 0);
  assert.strictEqual((await store.listChats({ tab: 'locked' })).length, 1);
});

test('broadcast sends only to consented contacts', async () => {
  const { engine, wa } = await makeEngine();
  await engine.onMessage(incoming(J, 'x'));
  await engine.onMessage(incoming(J, '1'));
  await engine.onMessage(incoming(J, '1')); // consent yes
  const J2 = '966522222222@s.whatsapp.net';
  await engine.onMessage(incoming(J2, 'x'));
  wa.sent.length = 0;
  await engine.createBroadcast({ text: 'إعلان', sendAt: 1 });
  await engine.tickBroadcasts();
  assert.deepStrictEqual(wa.sent.map((s) => s.jid), [J]);
  const [b] = await engine.listBroadcasts();
  assert.strictEqual(b.status, 'done');
  assert.strictEqual(b.sent, 1);
});

test('simulate does not touch real data', async () => {
  const { engine } = await makeEngine();
  let r = await engine.simulate({ input: 'hi' });
  assert.ok(r.ok);
  r = await engine.simulate({ state: r.state, contact: r.contact, input: '5' });
  r = await engine.simulate({ state: r.state, contact: r.contact, input: 'سؤال' });
  assert.match(r.replies[0], /الذكاء الاصطناعي/);
  assert.strictEqual((await engine.listInbox()).length, 0);
});

test('flow save rejects invalid, accepts valid', async () => {
  const { engine } = await makeEngine();
  const bad = JSON.parse(JSON.stringify(engine.flow));
  bad.root.children[0].type = 'zzz';
  assert.ok(!(await engine.saveFlow(bad)).ok);
  const good = JSON.parse(JSON.stringify(engine.flow));
  good.root.text = 'جديد {name}';
  assert.ok((await engine.saveFlow(good)).ok);
  assert.strictEqual(engine.flow.root.text, 'جديد {name}');
});

test('file store persists to disk', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itq-'));
  const s = new FileStore(dir);
  await s.init();
  await s.set('a', '1');
  await s.addMessage({ jid: 'x@s.whatsapp.net', id: '1', text: 't', ts: 5 });
  await s.close();
  const s2 = new FileStore(dir);
  await s2.init();
  assert.strictEqual(await s2.get('a'), '1');
  assert.strictEqual((await s2.messages('x@s.whatsapp.net')).length, 1);
});

function request(port, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ port, method, path, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('HTTP API: auth, health, routes', async () => {
  const { engine } = await makeEngine();
  const cfg = { token: 'T'.repeat(40), secret: 'S'.repeat(40) };
  const server = createServer(engine, cfg);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    assert.strictEqual((await request(port, 'GET', '/health')).json.ok, true);
    assert.strictEqual((await request(port, 'GET', '/status')).status, 401);
    assert.strictEqual((await request(port, 'GET', '/status', null, 'wrong')).status, 401);
    const st = await request(port, 'GET', '/status', null, cfg.token);
    assert.strictEqual(st.status, 200);
    assert.strictEqual(st.json.wa.state, 'open');
    const put = await request(port, 'PUT', '/settings', { ownerName: 'أحمد' }, cfg.token);
    assert.strictEqual(put.json.settings.ownerName, 'أحمد');
    await engine.onMessage(incoming(J, 'hi'));
    const chats = await request(port, 'GET', '/chats?tab=chats', null, cfg.token);
    assert.strictEqual(chats.json.chats.length, 1);
    const msgs = await request(port, 'GET', '/chats/' + encodeURIComponent(J) + '/messages', null, cfg.token);
    assert.ok(msgs.json.messages.length >= 2);
    const send = await request(port, 'POST', '/chats/' + encodeURIComponent(J) + '/send', { text: 'يدوي' }, cfg.token);
    assert.strictEqual(send.json.ok, true);
    const bad = await request(port, 'POST', '/chats/' + encodeURIComponent('bad jid') + '/send', { text: 'x' }, cfg.token);
    assert.strictEqual(bad.status, 400);
    const code = await request(port, 'POST', '/code/test', { code: 'process.exit()' }, cfg.token);
    assert.strictEqual(code.json.ok, false);
    assert.strictEqual((await request(port, 'GET', '/nope', null, cfg.token)).status, 404);
    // brute force lockout
    let last;
    for (let i = 0; i < 12; i++) last = await request(port, 'GET', '/status', null, 'bad' + i);
    assert.strictEqual(last.status, 429);
  } finally {
    server.close();
  }
});
