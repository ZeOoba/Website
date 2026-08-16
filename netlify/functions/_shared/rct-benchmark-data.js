'use strict';
// Thin CommonJS re-export of the benchmark JSON.
// Node's ESM loader needs an import attribute to load JSON directly, which not
// every bundler in the chain honours; requiring it from CJS works both bundled
// and under `node --test`, so the ESM callers import this instead.
module.exports = require('./rct-benchmark.json');
