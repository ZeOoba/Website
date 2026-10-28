'use strict';
// Stand-in for @netlify/blobs in chat-edge.test.js (esbuild `alias`). By default no store exists, which
// models "Blobs unavailable" so the existing in-memory-limiter tests run unchanged (the durable layer
// fails open). A test installs a store with globalThis.__chatRateStore = { get, setJSON }.
module.exports = {
  getStore() {
    const store = globalThis.__chatRateStore;
    if (!store) throw new Error('blobs unavailable (test default)');
    return store;
  },
};
