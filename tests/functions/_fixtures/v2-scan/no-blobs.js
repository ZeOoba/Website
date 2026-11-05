'use strict';
// NEGATIVE: unrelated imports only.
const path = require('node:path');
exports.handler = async () => ({ statusCode: 200, body: path.sep });
