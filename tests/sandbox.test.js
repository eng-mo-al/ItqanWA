'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sb = require('../src/sandbox/sandbox');

test('simple code returns reply', () => {
  const r = sb.run('return "x" + ctx.input;', { input: '5' });
  assert.ok(r.ok);
  assert.deepStrictEqual(r.replies, ['x5']);
});

test('infinite loop times out', () => {
  const r = sb.run('while(true){}', {}, 100);
  assert.ok(!r.ok);
  assert.match(r.error, /انتهى وقت/);
});

test('denied words rejected', () => {
  for (const c of ['require("fs")', 'process.exit()', 'eval("1")', 'this.constructor.constructor("return 1")()', 'await x']) {
    assert.ok(sb.check(c), c);
  }
});

test('escape via obfuscated constructor cannot reach host process', () => {
  const code = 'var f = ctx.reply["con"+"structor"]["con"+"structor"]; try { return String(typeof f("return pro"+"cess")().version); } catch(e) { return "blocked:" + e.message; }';
  const r = sb.run(code, {});
  assert.ok(r.ok);
  assert.ok(!/^v\d/.test(r.replies[0]), r.replies[0]);
});

test('reply count is capped', () => {
  const r = sb.run('for (var i = 0; i < 50; i++) ctx.reply("x");', {});
  assert.ok(r.ok);
  assert.strictEqual(r.replies.length, 10);
});

test('ctx is frozen', () => {
  const r = sb.run('try { ctx.input = "changed"; } catch (e) {} return ctx.input;', { input: 'orig' });
  assert.deepStrictEqual(r.replies, ['orig']);
});

test('runtime error reported', () => {
  const r = sb.run('throw new Error("bad");', {});
  assert.ok(!r.ok);
  assert.match(r.error, /bad/);
});

test('syntax error reported by check', () => {
  assert.match(sb.check('return (;'), /صياغة/);
});

test('review passes good code and fails bad', () => {
  assert.ok(sb.review('ctx.reply("hi");').ok);
  assert.ok(!sb.review('return ctx.nope.x;').ok);
});

test('memory set limited and returned', () => {
  const r = sb.run('ctx.memory.set("k","v"); return ctx.memory.get("a");', { memory: { a: '1' } });
  assert.deepStrictEqual(r.memory, { k: 'v' });
  assert.deepStrictEqual(r.replies, ['1']);
});
