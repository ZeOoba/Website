// Pure logic for scripts/check-form-hooks.mjs: does Netlify's LIVE form-notification config match what the repo
// assumes? The notify functions only run if a `submission_created` URL hook points at them, and that hook lives in
// the Netlify UI, invisible to the repo and to every test here. On 2026-11-05 owner-lead-notify.js (the owner
// form's formatted email to Gabriel and Eric) turned out to have no hook at all: it had never run in production.
//
// Hook shape (Netlify API listHooksBySiteId): { type: 'url'|'email'|..., event, form_name: string|null (null =
// every form), disabled, data: { url?, email?, signature_secret? } }. Nothing here ever returns data.signature_secret.

const FN_PATH = /\/\.netlify\/functions\/([A-Za-z0-9_-]+)\/?$/;

// netlify/functions/<fn>.js files that verify a Netlify webhook signature are webhook targets; WATCHED_FORM names
// the one form each one acts on (they 200-skip everything else).
export function webhookTargets(sources) {
  const out = [];
  for (const [file, src] of Object.entries(sources)) {
    if (!/verifyNetlifyWebhookSignature\s*\(/.test(src)) continue;
    const m = /\bWATCHED_FORM\s*=\s*['"]([^'"]+)['"]/.exec(src);
    if (!m) continue;
    out.push({ fn: file.replace(/\\/g, '/').split('/').pop().replace(/\.(m?js)$/, ''), form: m[1] });
  }
  return out.sort((a, b) => a.fn.localeCompare(b.fn));
}

// Hosts that serve this site's production functions. A hook aimed anywhere else (a deploy preview, a typo, plain
// http) never runs the production function, so it does not count as wiring it (2026-11-05 review).
const SITE_HOSTS = new Set(['oxfordra.net', 'www.oxfordra.net', 'snazzy-frangipane-de3841.netlify.app']);

function parse(raw) {
  try { return new URL(raw); } catch { return null; }
}
function hostOf(raw) {
  const u = parse(raw);
  return u ? u.hostname : '(invalid url)';
}
const live = (h) => h && h.event === 'submission_created' && h.disabled !== true;
const covers = (h, form) => h.form_name == null || h.form_name === form;
// The function a hook's URL names, wherever it points (used only to explain a misaimed hook).
const pathFnOf = (h) => {
  const u = parse(h.data && h.data.url);
  const m = u && FN_PATH.exec(u.pathname);
  return m ? m[1] : null;
};
// The production function a hook actually runs: https, on one of this site's hosts.
const fnOf = (h) => {
  const u = parse(h.data && h.data.url);
  if (!u) return null;
  if (!SITE_HOSTS.has(u.hostname) || u.protocol !== 'https:') return null;
  const m = FN_PATH.exec(u.pathname);
  return m ? m[1] : null;
};
// Email addresses are reported masked (each one, if Netlify stores a list): the report may land in a
// scheduled-task log or a chat transcript.
export function maskEmail(email) {
  const parts = String(email || '').split(/[\s,;]+/).filter(Boolean);
  if (!parts.length) return '***';
  return parts.map((s) => {
    const at = s.indexOf('@');
    return at > 0 ? `${s[0]}***${s.slice(at)}` : '***';
  }).join(', ');
}

// forms: every Netlify form name the site registers (from the repo's data-netlify forms).
// Returns { problems: [...], notes: [...] }; a problem means a lead path that silently does not notify.
export function auditFormHooks({ hooks, targets, forms }) {
  const problems = [];
  const notes = [];
  const submissionHooks = (hooks || []).filter(live);
  const urlHooks = submissionHooks.filter((h) => h.type === 'url');
  const emailHooks = submissionHooks.filter((h) => h.type === 'email');
  const targetFns = new Set(targets.map((t) => t.fn));

  for (const t of targets) {
    const pointing = urlHooks.filter((h) => fnOf(h) === t.fn);
    const misaimed = urlHooks.filter((h) => fnOf(h) !== t.fn && pathFnOf(h) === t.fn);
    if (!pointing.some((h) => covers(h, t.form))) {
      problems.push({
        kind: 'unregistered',
        fn: t.fn,
        form: t.form,
        detail: pointing.length
          ? `${t.fn} has a hook, but scoped to ${pointing.map((h) => h.form_name).join(', ')}, never "${t.form}": it never runs for the form it handles`
          : misaimed.length
          ? `the hook for /.netlify/functions/${t.fn} points at ${misaimed.map((h) => `${parse(h.data.url).protocol}//${hostOf(h.data.url)}`).join(', ')}, not this site over https: the production function never runs`
          : `no submission_created hook points at /.netlify/functions/${t.fn}: it never runs, so "${t.form}" submissions get none of its email or failure logging`,
        fix: `Netlify > Forms > Form notifications > Add notification > HTTP POST request: event "New form submission", form "${t.form}", URL https://oxfordra.net/.netlify/functions/${t.fn}, JWS secret = the same value as NETLIFY_WEBHOOK_SECRET`,
      });
    }
  }

  for (const h of urlHooks) {
    const fn = fnOf(h);
    const scope = h.form_name == null ? 'every form' : h.form_name;
    if (fn && !targetFns.has(fn)) notes.push({ kind: 'unknown-function', detail: `a hook (${scope}) points at /.netlify/functions/${fn}, which is not a webhook target in this repo` });
    else if (!fn) notes.push({ kind: 'external', detail: `an external URL hook on ${hostOf(h.data && h.data.url)} receives ${scope} (not managed by this repo)` });
  }
  for (const h of emailHooks) {
    notes.push({ kind: 'email', detail: `Netlify emails ${maskEmail(h.data && h.data.email)} for ${h.form_name == null ? 'every form' : h.form_name}` });
  }

  for (const form of [...new Set(forms)].sort()) {
    const byEmail = emailHooks.some((h) => covers(h, form));
    const byFunction = targets.some((t) => t.form === form && urlHooks.some((h) => fnOf(h) === t.fn && covers(h, form)));
    if (!byEmail && !byFunction) {
      problems.push({ kind: 'unnotified', form, detail: `nothing emails anyone when "${form}" is submitted (no email notification and no wired notify function)`, fix: `add a Netlify email notification for "${form}", or wire a notify function for it` });
    }
  }
  return { problems, notes };
}

export function formatReport({ problems, notes }) {
  const lines = [];
  for (const p of problems) lines.push(`PROBLEM ${p.kind}: ${p.detail}\n  fix: ${p.fix}`);
  for (const n of notes) lines.push(`note    ${n.kind}: ${n.detail}`);
  lines.push(problems.length ? `${problems.length} problem(s)` : 'OK: every webhook function is wired and every form notifies someone');
  return lines.join('\n');
}
