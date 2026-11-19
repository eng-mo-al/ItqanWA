'use strict';
const sandbox = require('../sandbox/sandbox');

const HOME_WORDS = new Set(['00', 'الرئيسية', 'الرئيسيه', 'القائمة', 'القائمه', 'menu', 'home']);
const BACK_WORDS = new Set(['0', 'رجوع', 'back']);
const MAX_REPLY = 4000;

const IMPORTANCE = { 1: 'high', 2: 'medium', 3: 'low' };

function normDigits(s) {
  return String(s)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function fill(text, vars) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

function resolve(flow, path) {
  let node = flow.root;
  if (!Array.isArray(path) || path[0] !== node.id) return null;
  for (let i = 1; i < path.length; i++) {
    const next = (node.children || []).find((c) => c.id === path[i]);
    if (!next) return null;
    node = next;
  }
  return node;
}

function kids(node) {
  return ['ask', 'consent', 'forward', 'ai', 'code'].includes(node.type) ? [] : node.children || [];
}

function footer(isRoot) {
  return isRoot ? '' : '\n\n0. رجوع ↩️\n00. الرئيسية 🏠';
}

function optionsText(node, isRoot) {
  const list = kids(node);
  const lines = list.map((c, i) => `${i + 1}. ${c.title}`);
  return (lines.length ? lines.join('\n') : '') + footer(isRoot);
}

function showNode(node, isRoot, vars, withText = true) {
  const parts = [];
  if (withText && node.text) parts.push(fill(node.text, vars));
  const opt = optionsText(node, isRoot);
  if (opt.trim()) parts.push(opt.replace(/^\n+/, ''));
  return parts.join('\n\n');
}

function newState(flow) {
  return { path: [flow.root.id], mode: 'nav', qi: 0, draft: '' };
}

async function handleMessage({ flow, state: prevState, contact: prevContact, text, settings = {}, hooks = {} }) {
  const contact = { ...prevContact, memory: { ...((prevContact && prevContact.memory) || {}) } };
  const effects = [];
  const replies = [];
  const isNew = !prevState;
  let state = prevState ? { ...prevState, path: [...(prevState.path || [])] } : newState(flow);

  let node = resolve(flow, state.path);
  let stale = false;
  if (!node) { state = newState(flow); node = flow.root; stale = true; }

  const raw = String(text || '').trim().slice(0, 2000);
  const t = normDigits(raw);
  const lower = t.toLowerCase();
  const vars = () => ({
    name: contact.nickname || contact.name || 'ضيفنا الكريم',
    nickname: contact.nickname || '',
    owner: settings.ownerName || 'المهندس',
  });
  const cur = () => resolve(flow, state.path) || flow.root;
  const isRoot = () => state.path.length <= 1;
  const say = (s) => { if (s) replies.push(String(s).slice(0, MAX_REPLY)); };
  const resetMode = () => { state.mode = 'nav'; state.qi = 0; state.draft = ''; };
  const showCurrent = (withText = true) => say(showNode(cur(), isRoot(), vars(), withText));
  const goHome = () => { state = newState(flow); };
  const popToParent = () => { if (state.path.length > 1) state.path.pop(); resetMode(); };

  async function enter(n) {
    switch (n.type) {
      case 'ask':
        state.mode = 'ask';
        state.qi = 0;
        say(fill(n.text, vars()));
        say(fill(n.questions[0].text, vars()) + footer(false));
        return;
      case 'consent':
        state.mode = 'consent';
        say(`${fill(n.text, vars())}\n\n1. ${n.yesLabel || 'موافق'}\n2. ${n.noLabel || 'غير موافق'}${footer(false)}`);
        return;
      case 'forward':
        state.mode = 'compose';
        say(fill(n.text || 'اكتب رسالتك الآن:', vars()) + footer(false));
        return;
      case 'ai':
        state.mode = 'ai';
        say(fill(n.text || 'اكتب سؤالك. أرسل 0 للخروج.', vars()));
        return;
      case 'code': {
        const r = sandbox.run(n.code, { input: raw, contact, memory: contact.memory });
        if (r.ok) {
          r.replies.forEach((x) => say(fill(x, vars())));
          Object.assign(contact.memory, r.memory);
        } else {
          say('⚠️ تعذر تنفيذ هذا الخيار حالياً.');
          effects.push({ type: 'code_error', node: n.id, error: r.error });
        }
        popToParent();
        say(showNode(cur(), isRoot(), vars(), false));
        return;
      }
      default:
        resetMode();
        say(showNode(n, state.path.length <= 1, vars()));
    }
  }

  if (isNew || stale) {
    goHome();
    showCurrent();
    return { replies, state, contact, effects };
  }

  // Global navigation (works in every mode)
  if (HOME_WORDS.has(lower)) {
    goHome();
    showCurrent();
    return { replies, state, contact, effects };
  }
  if (BACK_WORDS.has(lower)) {
    if (state.mode !== 'nav') {
      popToParent();
    } else if (state.path.length > 1) {
      state.path.pop();
    }
    showCurrent();
    return { replies, state, contact, effects };
  }

  switch (state.mode) {
    case 'ask': {
      const q = node.questions && node.questions[state.qi];
      if (!q) { goHome(); showCurrent(); break; }
      if (!raw) { say('اكتب إجابتك نصاً من فضلك.'); break; }
      const answer = raw.slice(0, 200);
      contact.memory[q.key] = answer;
      if (q.key === 'nickname' || q.key === 'name') contact.nickname = answer;
      state.qi += 1;
      if (state.qi < node.questions.length) {
        say(fill(node.questions[state.qi].text, vars()) + footer(false));
      } else {
        say(fill(node.afterText || 'شكراً لك، تم الحفظ ✅', { ...vars(), answer }));
        popToParent();
        say(showNode(cur(), isRoot(), vars(), false));
      }
      break;
    }
    case 'consent': {
      if (t === '1' || t === '2') {
        contact.consent = t === '1';
        contact.consentAt = Date.now();
        effects.push({ type: 'consent', value: contact.consent });
        say(fill(t === '1' ? node.yesText || 'تم ✅' : node.noText || 'تم.', vars()));
        popToParent();
        say(showNode(cur(), isRoot(), vars(), false));
      } else {
        say('اختر 1 أو 2.' + footer(false));
      }
      break;
    }
    case 'compose': {
      if (!raw) { say('اكتب رسالتك نصاً من فضلك.'); break; }
      state.draft = raw;
      state.mode = 'importance';
      say('ما أهمية رسالتك؟\n\n1. مهمة 🔴\n2. متوسطة 🟠\n3. غير مهمة 🟢' + footer(false));
      break;
    }
    case 'importance': {
      const level = IMPORTANCE[t];
      if (!level) { say('اختر 1 أو 2 أو 3.' + footer(false)); break; }
      const item = { text: state.draft, importance: level };
      effects.push({ type: 'inbox', item });
      if (hooks.saveInbox) await hooks.saveInbox(item, contact);
      say('✅ وصلت رسالتك إلى ' + (settings.ownerName || 'المهندس') + ' بشكل خاص، وسيطّلع عليها قريباً.');
      popToParent();
      say(showNode(cur(), isRoot(), vars(), false));
      break;
    }
    case 'ai': {
      if (!raw) { say('اكتب سؤالك نصاً من فضلك.'); break; }
      let answer;
      try {
        answer = hooks.ai ? await hooks.ai(raw, contact) : null;
      } catch (e) {
        effects.push({ type: 'ai_error', error: String(e.message || e).slice(0, 200) });
      }
      say(answer || 'عذراً، المساعد الذكي غير متاح حالياً. أرسل 0 للرجوع.');
      break;
    }
    default: {
      const list = kids(node);
      if (/^\d{1,3}$/.test(t)) {
        const n = parseInt(t, 10);
        if (n >= 1 && n <= list.length) {
          state.path.push(list[n - 1].id);
          await enter(list[n - 1]);
          break;
        }
      }
      if (list.length) {
        say('⚠️ خيار غير صحيح، اختر رقماً من القائمة:\n\n' + showNode(node, isRoot(), vars(), false));
      } else {
        say('أرسل 0 للرجوع أو 00 للرئيسية.');
      }
    }
  }

  return { replies, state, contact, effects };
}

module.exports = { handleMessage, resolve, newState, normDigits, fill };
