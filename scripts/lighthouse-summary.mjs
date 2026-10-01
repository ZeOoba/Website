#!/usr/bin/env node
// Summarises Lighthouse JSON reports against the site's performance budget.
//
//   node scripts/lighthouse-summary.mjs <dir-with-lhr-json-files>
//
// INFORMATIONAL BY DESIGN. Lab numbers on a shared CI runner are noisy (a good page can
// swing several points between runs), so this never fails the build: it prints a table,
// writes it to the job summary, and raises a ::warning:: per metric over budget so a
// regression is visible on the PR without a flaky red X. Promote it to a gate only after
// a few weeks of baselines say what the noise floor actually is.
//
// Budgets are the targets already stated for this site (README / website-perfection skill):
// LCP <= 2.5 s, CLS <= 0.1, TBT <= 200 ms, and every category score >= 90.
import { readdirSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUDGET = { lcpMs: 2500, cls: 0.1, tbtMs: 200, minScore: 90 };
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];

export function evaluate(lhr) {
  const audit = (id) => lhr.audits?.[id]?.numericValue;
  const scores = Object.fromEntries(CATEGORIES.map((c) => [c, lhr.categories?.[c]?.score == null ? null : Math.round(lhr.categories[c].score * 100)]));
  const metrics = { lcpMs: audit('largest-contentful-paint'), cls: audit('cumulative-layout-shift'), tbtMs: audit('total-blocking-time') };
  const over = [];
  if (metrics.lcpMs > BUDGET.lcpMs) over.push(`LCP ${(metrics.lcpMs / 1000).toFixed(2)} s > ${BUDGET.lcpMs / 1000} s`);
  if (metrics.cls > BUDGET.cls) over.push(`CLS ${metrics.cls.toFixed(3)} > ${BUDGET.cls}`);
  if (metrics.tbtMs > BUDGET.tbtMs) over.push(`TBT ${Math.round(metrics.tbtMs)} ms > ${BUDGET.tbtMs} ms`);
  for (const c of CATEGORIES) if (scores[c] != null && scores[c] < BUDGET.minScore) over.push(`${c} ${scores[c]} < ${BUDGET.minScore}`);
  return { url: lhr.finalDisplayedUrl || lhr.finalUrl || lhr.requestedUrl, scores, metrics, over };
}

export function markdown(results) {
  const pathOf = (u) => { try { return new URL(u).pathname; } catch { return u; } };
  const rows = results.map((r) => `| ${pathOf(r.url)} | ${r.scores.performance} | ${r.scores.accessibility} | ${r.scores['best-practices']} | ${r.scores.seo} | ${(r.metrics.lcpMs / 1000).toFixed(2)} s | ${r.metrics.cls.toFixed(3)} | ${Math.round(r.metrics.tbtMs)} ms | ${r.over.length ? r.over.join('; ') : 'within budget'} |`);
  return [
    '### Lighthouse (informational, lab data on a shared runner, never fails the build)',
    '',
    `Budget: LCP <= ${BUDGET.lcpMs / 1000} s, CLS <= ${BUDGET.cls}, TBT <= ${BUDGET.tbtMs} ms, categories >= ${BUDGET.minScore}.`,
    '',
    '| Page | Perf | A11y | Best | SEO | LCP | CLS | TBT | Status |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node scripts/lighthouse-summary.mjs <dir>'); process.exit(2); }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) { console.error(`no Lighthouse JSON reports in ${dir}: the run produced nothing`); process.exit(1); }
  const results = files.map((f) => evaluate(JSON.parse(readFileSync(path.join(dir, f), 'utf8'))));
  const md = markdown(results);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  for (const r of results) for (const o of r.over) console.log(`::warning title=Lighthouse budget::${new URL(r.url).pathname}: ${o}`);
}
