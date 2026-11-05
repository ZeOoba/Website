// Guards the broker score card on for-brokers.html and the poller in
// broker-upload.js that feeds it (2026-11-03 review of #192).
//
// Defects pinned:
//  - server JSON reached card.innerHTML by string concatenation, escaped field
//    by field; json.score was missed until #192. The card is now built with
//    textContent, so no server string may ever reach an innerHTML sink.
//  - Number(null) rendered a withheld score as "0/100" and undefined as
//    "NaN/100"; a non-numeric score must fall back to the unavailable message.
//  - gateFailed with no `gates` object threw a TypeError.
//  - pollForScore's .catch wrapped onReady, so a render exception was retried
//    as a network error every 3 s for two minutes and the broker never saw a
//    result.
//
// Both scripts are IIFEs with no exports, so each runs in a vm against a
// minimal DOM stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const PAGE_SCRIPT = [...read('for-brokers.html').matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .find((s) => s.includes('function renderScoreCard'));

/* ---------- Minimal DOM stub ---------- */

const htmlSinks = [];

class El {
  constructor(tag, id = '') {
    this.tagName = tag;
    this.id = id;
    this.className = '';
    this.style = {};
    this.children = [];
    this._text = '';
  }
  appendChild(c) { this.children.push(c); return c; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(v) { htmlSinks.push(String(v)); this._text = String(v); this.children = []; }
  get innerHTML() { return this._text; }
  querySelector() { return null; }
  addEventListener(type, fn) { this.listeners = { ...this.listeners, [type]: fn }; }
  scrollIntoView() {}
  findByClass(cls) {
    if (this.className.split(' ').includes(cls)) return this;
    for (const c of this.children) { const hit = c.findByClass(cls); if (hit) return hit; }
    return null;
  }
}

async function renderWith(json) {
  htmlSinks.length = 0;
  const els = {};
  for (const id of ['brokerForm', 'brokerSubmitBtn', 'brokerSuccess', 'brokerError', 'scoreCard', 'brokerPendingMessage']) {
    els[id] = new El(id === 'brokerForm' ? 'form' : 'div', id);
  }
  els.scoreCard.style.display = 'none';
  els.brokerPendingMessage.textContent = 'analyzing';
  els.brokerForm.children = [els.brokerSuccess];
  let callbacks;
  const window = {
    ORA_BROKER_UPLOAD: {
      submit: async () => ({ submissionId: 's1', statusToken: 't1' }),
      pollForScore: (id, token, onReady, onUnavailable) => { callbacks = { onReady, onUnavailable }; },
    },
  };
  const document = {
    getElementById: (id) => els[id] ?? null,
    createElement: (tag) => new El(tag),
  };
  vm.runInNewContext(PAGE_SCRIPT, { window, document, Array, String, Number, isFinite });
  els.brokerForm.listeners.submit({ preventDefault() {} });
  await new Promise((r) => setImmediate(r));
  assert.ok(callbacks, 'submit handler never reached pollForScore');
  callbacks.onReady(json);
  return { card: els.scoreCard, pending: els.brokerPendingMessage };
}

const READY = {
  status: 'ready', score: 82, gateFailed: false, gates: { propertyType: 'PASS', market: 'PASS' },
  categories: [{ key: 'size', label: 'Size', possible: 20, earned: 18, excluded: false, note: 'In range' }],
};

test('for-brokers.html: the inline broker script is found', () => {
  assert.ok(PAGE_SCRIPT, 'no inline <script> in for-brokers.html defines renderScoreCard');
});

test('score card renders score, band and category rows', async () => {
  const { card, pending } = await renderWith(READY);
  assert.equal(card.style.display, '');
  assert.equal(pending.style.display, 'none');
  assert.match(card.className, /score-card--strong/);
  assert.equal(card.findByClass('score-card__value').textContent, '82/100');
  assert.equal(card.findByClass('score-card__status').textContent, 'Strong Fit');
  assert.equal(card.findByClass('score-row__pts').textContent, '18/20');
});

test('no server-supplied string reaches an innerHTML sink', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  await renderWith({
    ...READY,
    score: 50,
    categories: [{ key: 'k', label: evil, possible: evil, earned: evil, excluded: false, note: evil }],
  });
  assert.deepEqual(htmlSinks.filter((h) => h.includes('img')), [], 'hostile category text was written through innerHTML');
});

for (const [desc, score] of [['null', null], ['undefined', undefined], ['a string', '<img src=x onerror=alert(1)>'], ['NaN', NaN]]) {
  test(`score = ${desc} shows the unavailable message, never a fabricated number`, async () => {
    const { card, pending } = await renderWith({ ...READY, score });
    assert.equal(card.style.display, 'none', 'score card was shown for a non-numeric score');
    assert.match(pending.textContent, /review it directly/);
  });
}

test('gateFailed without a gates object renders the market-gate line instead of throwing', async () => {
  const { card } = await renderWith({ ...READY, score: 30, gateFailed: true, gates: undefined });
  assert.match(card.className, /score-card--outside/);
  assert.match(card.findByClass('score-card__gate').textContent, /market does not match/);
});

test('missing categories render an empty grid instead of throwing', async () => {
  const { card } = await renderWith({ ...READY, categories: undefined });
  assert.equal(card.findByClass('score-card__grid').children.length, 0);
});

/* ---------- broker-upload.js pollForScore ---------- */

test('pollForScore: an onReady exception falls back to onUnavailable and stops polling', async () => {
  const window = {};
  let fetches = 0;
  let timers = 0;
  vm.runInNewContext(read('broker-upload.js'), {
    window,
    fetch: async () => { fetches++; return { text: async () => JSON.stringify({ status: 'ready', score: 1 }) }; },
    setTimeout: () => { timers++; },
    console: { error() {} },
    encodeURIComponent, JSON, Date,
  });
  let unavailable = 0;
  window.ORA_BROKER_UPLOAD.pollForScore('s1', 't1', () => { throw new TypeError('render failed'); }, () => { unavailable++; });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(fetches, 1);
  assert.equal(timers, 0, 'a render exception re-armed the poll');
  assert.equal(unavailable, 1);
});
