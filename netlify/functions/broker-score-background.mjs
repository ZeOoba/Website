// Netlify V2 background function. Must NOT export `handler` -- that marks a
// function as legacy V1, and Blobs auto-provisioning does not cover V1, which is
// what took broker scoring down on 2026-08-04. All orchestration lives in
// _shared/broker-scoring-run.js (CommonJS, unchanged); this file is transport only.
// Static `import` (not createRequire) is deliberate: Netlify's function bundler
// traces imports statically, so a createRequire call risks bundling this
// function without its dependencies and failing in production only.
import { runScoring } from './_shared/broker-scoring-run.js';

export default async (req) => {
  let body;
  try {
    // Read as text first so an empty body stays {} rather than throwing, which
    // is what the V1 `JSON.parse(event.body || '{}')` did.
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return new Response('invalid_json', { status: 400 });
  }

  const { submissionId, itemPath, fields } = body;
  if (!submissionId || !itemPath) return new Response('missing_fields', { status: 400 });

  await runScoring({ submissionId, itemPath, fields: fields || {} });
  return new Response('', { status: 202 });
};
