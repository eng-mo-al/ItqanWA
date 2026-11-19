'use strict';
const { FileStore } = require('./file');
const { MySqlStore } = require('./mysql');

async function createStore(cfg) {
  let store;
  if (cfg.databaseUrl) {
    store = new MySqlStore(cfg.databaseUrl, cfg.dbSsl);
  } else {
    console.warn('[store] DATABASE_URL not set: using local file storage (data is lost on Render restarts).');
    store = new FileStore(cfg.dataDir);
  }
  await store.init();
  return store;
}

module.exports = { createStore, FileStore, MySqlStore };
