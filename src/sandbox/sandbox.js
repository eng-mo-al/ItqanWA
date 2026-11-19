'use strict';
const vm = require('vm');

// Static screening is a convenience for the owner. The real isolation is that
// user code runs in a fresh vm context that is handed NO host objects:
// input is passed as JSON text and the result comes back as JSON text.
const DENY = /\b(require|process|import|eval|Function|constructor|__proto__|prototype|globalThis|Reflect|Proxy|WebAssembly|setTimeout|setInterval|setImmediate|async|await|Promise)\b/;

const MAX_CODE = 8000;
const MAX_REPLIES = 10;

function build(code, input) {
  const lit = JSON.stringify(JSON.stringify(input));
  return `"use strict";
const __in = JSON.parse(${lit});
const __out = { replies: [], memory: {} };
const ctx = Object.freeze({
  input: __in.input,
  contact: Object.freeze(__in.contact),
  reply: function (t) { if (__out.replies.length < ${MAX_REPLIES}) __out.replies.push(String(t).slice(0, 4000)); },
  memory: Object.freeze({
    get: function (k) { return __in.memory[k]; },
    set: function (k, v) { __out.memory[String(k).slice(0, 30)] = String(v).slice(0, 500); }
  })
});
let __ret;
try {
  __ret = (function (ctx) {
${code}
  })(ctx);
} catch (e) { __out.error = String(e && e.message || e).slice(0, 300); }
if (typeof __ret === "string" && __ret && __out.replies.length < ${MAX_REPLIES}) __out.replies.push(__ret.slice(0, 4000));
JSON.stringify(__out);`;
}

function screen(code) {
  if (typeof code !== 'string' || !code.trim()) return 'الكود فارغ';
  if (code.length > MAX_CODE) return `الكود أطول من ${MAX_CODE} حرف`;
  const m = DENY.exec(code);
  if (m) return `الكلمة غير مسموحة في الأكواد: ${m[1]}`;
  return null;
}

function check(code) {
  const bad = screen(code);
  if (bad) return bad;
  try {
    new vm.Script(build(code, { input: '', contact: {}, memory: {} }), { filename: 'user-code.js' });
  } catch (e) {
    return 'خطأ في صياغة الكود: ' + e.message;
  }
  return null;
}

function run(code, { input = '', contact = {}, memory = {} } = {}, timeoutMs = 300) {
  const bad = check(code);
  if (bad) return { ok: false, error: bad, replies: [], memory: {} };
  const safeContact = {
    name: String(contact.name || ''),
    nickname: String(contact.nickname || ''),
    consent: !!contact.consent,
  };
  const script = new vm.Script(build(code, { input: String(input).slice(0, 2000), contact: safeContact, memory }), { filename: 'user-code.js' });
  const sandbox = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });
  try {
    const out = script.runInContext(sandbox, { timeout: timeoutMs });
    const parsed = JSON.parse(out);
    if (parsed.error) return { ok: false, error: parsed.error, replies: parsed.replies || [], memory: parsed.memory || {} };
    return { ok: true, error: null, replies: parsed.replies, memory: parsed.memory };
  } catch (e) {
    const msg = /timed out/i.test(String(e.message)) ? 'انتهى وقت التنفيذ (حلقة لا نهائية؟)' : String(e.message).slice(0, 300);
    return { ok: false, error: msg, replies: [], memory: {} };
  }
}

// Review + test before an owner's code is approved.
function review(code) {
  const problem = check(code);
  if (problem) return { ok: false, stage: 'check', error: problem };
  const samples = ['1', 'مرحبا', ''];
  for (const s of samples) {
    const r = run(code, { input: s, contact: { name: 'اختبار', nickname: 'اختبار' } });
    if (!r.ok) return { ok: false, stage: 'test', error: `فشل الاختبار مع المدخل "${s}": ${r.error}` };
  }
  const r = run(code, { input: 'اختبار', contact: { name: 'اختبار' } });
  return { ok: true, stage: 'done', sample: r };
}

module.exports = { check, run, review, screen };
