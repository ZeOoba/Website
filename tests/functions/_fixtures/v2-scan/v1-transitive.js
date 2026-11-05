'use strict';
// POSITIVE: a V1-style entry with no direct Blobs import. It reaches Blobs through a _shared module, which
// is exactly the shape that broke production on 2026-08-04 (V1 functions get no Blobs auto-provisioning).
const { getStore } = require('./_shared/cjs-store.js');
exports.handler = async () => ({ statusCode: 200, body: String(typeof getStore) });
