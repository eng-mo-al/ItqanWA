'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { handleMessage, normDigits } = require('../src/flow-runner/runner');
const { defaultFlow } = require('../src/flow-runner/default-flow');
const { validateFlow } = require('../src/flow-runner/validate');

const settings = { ownerName: 'المهندس محمد' };
const base = () => ({ jid: 'a@s.whatsapp.net', memory: {} });

async function step(flow, st, c, text, hooks = {}) {
  return handleMessage({ flow, state: st, contact: c, text, settings, hooks });
}

test('default flow is valid', () => {
  const v = validateFlow(defaultFlow());
  assert.deepStrictEqual(v.errors, []);
  assert.ok(v.ok);
});

test('arabic digits normalized', () => assert.strictEqual(normDigits('١٢٣۴'), '1234'));

test('first message shows welcome with owner and options', async () => {
  const r = await step(defaultFlow(), null, base(), 'مرحبا');
  assert.match(r.replies[0], /المهندس محمد/);
  assert.match(r.replies[0], /1\. تحليل رسالتي/);
  assert.match(r.replies[0], /5\. تحدث مع المساعد الذكي/);
});

test('consent yes stores consent and returns to menu', async () => {
  const f = defaultFlow();
  let r = await step(f, null, base(), 'hi');
  r = await step(f, r.state, r.contact, '1');
  assert.match(r.replies[0], /1\. موافق/);
  r = await step(f, r.state, r.contact, '1');
  assert.strictEqual(r.contact.consent, true);
  assert.strictEqual(r.state.path.length, 1);
});

test('nested navigation, back and home', async () => {
  const f = defaultFlow();
  let r = await step(f, null, base(), 'hi');
  r = await step(f, r.state, r.contact, '2');
  assert.deepStrictEqual(r.state.path, ['root', 'works']);
  r = await step(f, r.state, r.contact, '١');
  assert.deepStrictEqual(r.state.path, ['root', 'works', 'works1']);
  r = await step(f, r.state, r.contact, '0');
  assert.deepStrictEqual(r.state.path, ['root', 'works']);
  r = await step(f, r.state, r.contact, '1');
  r = await step(f, r.state, r.contact, '00');
  assert.deepStrictEqual(r.state.path, ['root']);
});

test('invalid option re-shows menu', async () => {
  const f = defaultFlow();
  let r = await step(f, null, base(), 'hi');
  r = await step(f, r.state, r.contact, '99');
  assert.match(r.replies[0], /خيار غير صحيح/);
});

test('intro asks two questions and saves nickname', async () => {
  const f = defaultFlow();
  let r = await step(f, null, base(), 'hi');
  r = await step(f, r.state, r.contact, '4');
  assert.match(r.replies.join('\n'), /الاسم الذي تحب/);
  r = await step(f, r.state, r.contact, 'أبو سعد');
  assert.strictEqual(r.contact.nickname, 'أبو سعد');
  r = await step(f, r.state, r.contact, 'مهندس');
  assert.strictEqual(r.contact.memory.about, 'مهندس');
  assert.match(r.replies[0], /أبو سعد/);
  assert.strictEqual(r.state.mode, 'nav');
});

test('private message flow saves inbox with importance', async () => {
  const f = defaultFlow();
  const saved = [];
  const hooks = { saveInbox: async (i) => saved.push(i) };
  let r = await step(f, null, base(), 'hi', hooks);
  r = await step(f, r.state, r.contact, '3', hooks);
  r = await step(f, r.state, r.contact, 'أحتاج عرض سعر', hooks);
  assert.match(r.replies[0], /ما أهمية/);
  r = await step(f, r.state, r.contact, '9', hooks);
  assert.strictEqual(saved.length, 0);
  r = await step(f, r.state, r.contact, '1', hooks);
  assert.deepStrictEqual(saved, [{ text: 'أحتاج عرض سعر', importance: 'high' }]);
  assert.strictEqual(r.state.mode, 'nav');
});

test('ai mode routes text to hook until 0', async () => {
  const f = defaultFlow();
  const hooks = { ai: async (t) => 'رد:' + t };
  let r = await step(f, null, base(), 'hi', hooks);
  r = await step(f, r.state, r.contact, '5', hooks);
  r = await step(f, r.state, r.contact, 'سؤال', hooks);
  assert.strictEqual(r.replies[0], 'رد:سؤال');
  r = await step(f, r.state, r.contact, '0', hooks);
  assert.strictEqual(r.state.mode, 'nav');
  assert.strictEqual(r.state.path.length, 1);
});

test('ai failure gives friendly message', async () => {
  const f = defaultFlow();
  const hooks = { ai: async () => { throw new Error('boom'); } };
  let r = await step(f, null, base(), 'hi', hooks);
  r = await step(f, r.state, r.contact, '5', hooks);
  r = await step(f, r.state, r.contact, 'x', hooks);
  assert.match(r.replies[0], /غير متاح/);
});

test('code node runs in sandbox and returns to parent', async () => {
  const f = defaultFlow();
  f.root.children.push({ id: 'calc', type: 'code', title: 'كود', code: 'ctx.memory.set("seen","yes"); return "مرحبا " + ctx.contact.nickname;' });
  assert.ok(validateFlow(f).ok);
  let r = await step(f, null, { ...base(), nickname: 'سعد' }, 'hi');
  r = await step(f, r.state, r.contact, '6');
  assert.match(r.replies[0], /مرحبا سعد/);
  assert.strictEqual(r.contact.memory.seen, 'yes');
  assert.strictEqual(r.state.path.length, 1);
});

test('stale state (node removed) falls back to home', async () => {
  const f = defaultFlow();
  const st = { path: ['root', 'gone'], mode: 'nav', qi: 0, draft: '' };
  const r = await step(f, st, base(), '1');
  assert.deepStrictEqual(r.state.path, ['root']);
});

test('validator catches problems', () => {
  const f = defaultFlow();
  f.root.children.push({ id: 'works', type: 'menu', title: 'x' });
  f.root.children.push({ id: 'bad', type: 'nope', title: 'y' });
  f.root.children.push({ id: 'c', type: 'code', title: 'z', code: 'process.exit()' });
  f.root.children.push({ id: 'q', type: 'ask', title: 'q', questions: [{ key: 'bad key', text: '' }] });
  const v = validateFlow(f);
  assert.ok(!v.ok);
  assert.ok(v.errors.some((e) => /مكرر/.test(e)));
  assert.ok(v.errors.some((e) => /نوع غير معروف/.test(e)));
  assert.ok(v.errors.some((e) => /process/.test(e)));
  assert.ok(v.errors.some((e) => /مفتاح السؤال/.test(e)));
});
