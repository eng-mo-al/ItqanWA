'use strict';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

async function generate({ apiKey, model = 'gemini-2.5-flash', system = '', history = [], userText, timeoutMs = 20000, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('مفتاح Google غير مضبوط');
  const body = {
    contents: [
      ...history.map((h) => ({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: String(h.text).slice(0, 4000) }] })),
      { role: 'user', parts: [{ text: String(userText).slice(0, 4000) }] },
    ],
    generationConfig: { temperature: 0.7, maxOutputTokens: 700 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${BASE}${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
      throw new Error(`Gemini ${res.status}: ${String(msg).replace(apiKey, '***').slice(0, 200)}`);
    }
    const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    const text = (parts || []).map((p) => p.text || '').join('').trim();
    if (!text) throw new Error('رد فارغ من Gemini');
    return text;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('انتهت مهلة Gemini');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generate };
