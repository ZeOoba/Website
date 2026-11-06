'use strict';
// NEGATIVE: every Blobs mention below is inside a // comment.
// import { getStore } from '@netlify/blobs';
// const { getStore } = require('@netlify/blobs');
const inert = require('./_shared/inert.js'); // require('@netlify/blobs') -- trailing comment
exports.handler = async () => ({ statusCode: 200, body: JSON.stringify(inert) });
