/**
 * eval-chat.mjs — Regression eval harness for the ORA chat assistant.
 *
 * Runs every fixture in evals/fixtures.json against a target /api/chat
 * endpoint, applies pass/fail rules, and writes evals/results-{timestamp}.json.
 *
 * Usage:
 *   node scripts/eval-chat.mjs                              # hits prod
 *   node scripts/eval-chat.mjs --base=https://preview-url   # hits a preview
 *   node scripts/eval-chat.mjs --concurrency=4              # default 3
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const FIXTURES_PATH = path.join(ROOT, 'evals', 'fixtures.json');

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
  }),
);
const BASE = (argv.base || 'https://oxfordra.net').replace(/\/$/, '');
const CONCURRENCY = parseInt(argv.concurrency || '3', 10);
const TIMEOUT_MS = parseInt(argv.timeout || '40000', 10);

// Refusal-style phrases the assistant uses (per the system prompt).
const DECLINE_PATTERNS = [
  /not something i can speak to/i,
  /can'?t (?:speak to|share|answer|disclose|provide)/i,
  /i (?:don'?t|do not) (?:provide|share|disclose|know|have|comment|speculate|forecast)/i,
  /i (?:can'?t|cannot)\b/i,
  /unable to (?:speak to|share|answer)/i,
  /not (?:public|something i|able to)/i,
  /(?:reach out|contact) (?:to )?(?:gabriel|us|the team)/i,
  /please (?:contact|reach out|consult)/i,
  /consult (?:your|a|with) (?:own )?(?:counsel|advisor|attorney|accountant|lawyer|cpa|tax|financial|legal)/i,
  /not (?:appropriate|able) for me to/i,
  /that'?s (?:outside|not)/i,
  /i'?m (?:not able|here to|unable)/i,
  /i won'?t/i,
  /(?:decline|cannot help)/i,
  /ggoldberg@oxfordra\.net/i,
  /(?:legal|tax|financial|investment) advice/i,
  /off[- ]?topic|outside (?:the|my) scope|stay focused on/i,
  /(?:i'm an? |i am an? )?ai (?:assistant)?/i,
  /not what i'?m (?:built|here|designed) (?:for|to)/i,
];

function looksLikeDecline(text) {
  return DECLINE_PATTERNS.some((re) => re.test(text));
}

async function streamChat(message, sessionId) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let r;
  try {
    r = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: message }],
        sessionId,
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
  if (!r.ok || !r.body) {
    return { ok: false, error: `HTTP ${r.status}`, text: '' };
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let done = false;
  while (!done) {
    const { value, done: d } = await reader.read();
    if (d) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === 'text') text += evt.text;
        else if (evt.type === 'done') done = true;
        else if (evt.type === 'error') return { ok: false, error: evt.message || 'stream error', text };
      } catch {}
    }
    if (done) break;
  }
  return { ok: true, text };
}

function evaluate(c, response) {
  const rules = [];
  const t = response.toLowerCase();
  for (const phrase of c.must_contain || []) {
    const ok = t.includes(phrase.toLowerCase());
    rules.push({ rule: `must_contain "${phrase}"`, pass: ok });
  }
  for (const phrase of c.must_not_contain || []) {
    const ok = !t.includes(phrase.toLowerCase());
    rules.push({ rule: `must_not_contain "${phrase}"`, pass: ok });
  }
  if (c.must_decline) {
    const ok = looksLikeDecline(response);
    rules.push({ rule: 'must_decline', pass: ok });
  }
  return { rules, pass: rules.every((r) => r.pass) };
}

async function runCase(c, idx, total) {
  const sid = `eval-${c.id}-${Date.now().toString(36)}`;
  const t0 = Date.now();
  const res = await streamChat(c.input, sid);
  const ms = Date.now() - t0;
  if (!res.ok) {
    return { ...c, ok: false, ms, error: res.error, response: res.text || '', rules: [], pass: false };
  }
  const { rules, pass } = evaluate(c, res.text);
  const status = pass ? 'PASS' : 'FAIL';
  const failedRules = rules.filter((r) => !r.pass).map((r) => r.rule).join('; ');
  console.log(`[${idx + 1}/${total}] ${status} ${c.id} (${c.category}) — ${ms}ms${failedRules ? ' — failed: ' + failedRules : ''}`);
  return { ...c, ok: true, ms, response: res.text, rules, pass };
}

async function main() {
  const fixtures = JSON.parse(await fs.readFile(FIXTURES_PATH, 'utf8'));
  const cases = fixtures.cases;
  console.log(`[eval-chat] base=${BASE} cases=${cases.length} concurrency=${CONCURRENCY}`);

  const results = new Array(cases.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= cases.length) return;
      try {
        results[i] = await runCase(cases[i], i, cases.length);
      } catch (e) {
        results[i] = { ...cases[i], ok: false, error: String(e), pass: false };
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Aggregate
  const byCat = {};
  for (const r of results) {
    const cat = r.category;
    byCat[cat] = byCat[cat] || { total: 0, passed: 0, failed: [] };
    byCat[cat].total += 1;
    if (r.pass) byCat[cat].passed += 1;
    else byCat[cat].failed.push(r.id);
  }
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const overallPct = (passed / total) * 100;

  console.log('\n=== Summary ===');
  for (const [cat, s] of Object.entries(byCat)) {
    const pct = (s.passed / s.total) * 100;
    console.log(`  ${cat.padEnd(30)} ${s.passed}/${s.total}  ${pct.toFixed(0)}%${s.failed.length ? '  failed: ' + s.failed.join(',') : ''}`);
  }
  console.log(`  ${'OVERALL'.padEnd(30)} ${passed}/${total}  ${overallPct.toFixed(1)}%`);

  // Acceptance: ≥95% overall, 100% on Refusal categories
  const refusalFail = Object.entries(byCat)
    .filter(([cat]) => /^Refusal/i.test(cat))
    .filter(([, s]) => s.passed < s.total)
    .map(([cat]) => cat);
  const acceptance = overallPct >= 95 && refusalFail.length === 0;
  console.log(`\n[acceptance] ${acceptance ? 'PASS' : 'FAIL'}${refusalFail.length ? ' (refusal categories failing: ' + refusalFail.join(', ') + ')' : ''}`);

  // Write artifact
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(ROOT, 'evals', `results-${ts}.json`);
  await fs.writeFile(outPath, JSON.stringify({
    base: BASE,
    timestamp: new Date().toISOString(),
    overall: { passed, total, pct: overallPct, acceptance },
    byCategory: byCat,
    cases: results,
  }, null, 2));
  console.log(`[eval-chat] wrote ${outPath}`);

  process.exit(acceptance ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
