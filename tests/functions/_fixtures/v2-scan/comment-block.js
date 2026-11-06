'use strict';
/*
 * NEGATIVE: every Blobs mention below is inside a block comment.
 * import { getStore } from '@netlify/blobs';
 * const { getStore } = require('@netlify/blobs');
 */
const x = 1; /* await import('@netlify/blobs') */ const y = 2;
/** @see require('@netlify/blobs') */
exports.handler = async () => ({ statusCode: 200, body: String(x + y) });
