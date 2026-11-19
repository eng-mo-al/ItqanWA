'use strict';
const sandbox = require('../sandbox/sandbox');

const TYPES = ['menu', 'text', 'ask', 'consent', 'forward', 'ai', 'code'];
const LEAF_TYPES = ['ask', 'consent', 'forward', 'ai', 'code'];
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const KEY_RE = /^[A-Za-z0-9_]{1,30}$/;
const MAX_NODES = 300;
const MAX_DEPTH = 12;

function validateFlow(flow) {
  const errors = [];
  const warnings = [];
  let count = 0;
  const seen = new Set();

  if (!flow || typeof flow !== 'object' || !flow.root || typeof flow.root !== 'object') {
    return { ok: false, errors: ['الشجرة لا تحتوي على root'], warnings, nodeCount: 0 };
  }

  const walk = (n, depth, trail) => {
    count++;
    const label = `${trail}${n && n.title ? n.title : '?'}`;
    if (!n || typeof n !== 'object') { errors.push(`عقدة غير صالحة في ${trail}`); return; }
    if (count > MAX_NODES) { if (count === MAX_NODES + 1) errors.push(`عدد الخيارات أكبر من ${MAX_NODES}`); return; }
    if (depth > MAX_DEPTH) { errors.push(`العمق أكبر من ${MAX_DEPTH} عند: ${label}`); return; }
    if (typeof n.id !== 'string' || !ID_RE.test(n.id)) errors.push(`معرّف غير صالح عند: ${label}`);
    else if (seen.has(n.id)) errors.push(`معرّف مكرر: ${n.id}`);
    else seen.add(n.id);
    if (!TYPES.includes(n.type)) errors.push(`نوع غير معروف "${n.type}" عند: ${label}`);
    if (depth > 0 && (typeof n.title !== 'string' || !n.title.trim())) errors.push(`عنوان الخيار مطلوب عند: ${trail}`);
    if (typeof n.title === 'string' && n.title.length > 80) errors.push(`العنوان أطول من 80 حرف عند: ${label}`);
    if (n.text != null && (typeof n.text !== 'string' || n.text.length > 4000)) errors.push(`النص غير صالح أو أطول من 4000 عند: ${label}`);

    if (n.type === 'ask') {
      if (!Array.isArray(n.questions) || !n.questions.length) errors.push(`خيار الأسئلة بلا أسئلة: ${label}`);
      else n.questions.forEach((q, i) => {
        if (!q || !KEY_RE.test(q.key || '')) errors.push(`مفتاح السؤال ${i + 1} غير صالح عند: ${label}`);
        if (!q || typeof q.text !== 'string' || !q.text.trim()) errors.push(`نص السؤال ${i + 1} مطلوب عند: ${label}`);
      });
    }
    if (n.type === 'code') {
      const bad = sandbox.check(n.code);
      if (bad) errors.push(`كود "${label}": ${bad}`);
    }
    if (n.children != null && !Array.isArray(n.children)) { errors.push(`children يجب أن تكون قائمة عند: ${label}`); return; }
    const kids = n.children || [];
    if (LEAF_TYPES.includes(n.type) && kids.length) warnings.push(`الخيار "${label}" من نوع ${n.type} وسيتم تجاهل الخيارات الفرعية`);
    if (n.type === 'menu' && depth > 0 && !kids.length) warnings.push(`القائمة "${label}" بلا خيارات فرعية`);
    const titles = new Set();
    kids.forEach((k) => {
      if (k && typeof k.title === 'string') {
        if (titles.has(k.title)) warnings.push(`عنوان مكرر داخل "${label}": ${k.title}`);
        titles.add(k.title);
      }
      walk(k, depth + 1, label + ' › ');
    });
  };
  walk(flow.root, 0, '');
  return { ok: errors.length === 0, errors, warnings, nodeCount: count };
}

module.exports = { validateFlow, TYPES };
