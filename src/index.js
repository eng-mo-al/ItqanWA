'use strict';
const pino = require('pino');
const { load } = require('./config');
const { createStore } = require('./store');
const { WhatsAppConnection } = require('./whatsapp/connection');
const { Engine } = require('./engine');
const { createServer } = require('./api/server');

async function main() {
  const cfg = load();
  if (cfg.errors.length) {
    console.error('Configuration errors:\n - ' + cfg.errors.join('\n - '));
    process.exit(1);
  }
  const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
  const store = await createStore(cfg);
  const wa = new WhatsAppConnection({ store, logger });
  const engine = new Engine({ store, wa, config: cfg, logger: console });
  await engine.init();

  const server = createServer(engine, cfg);
  server.listen(cfg.port, '0.0.0.0', () => console.log(`[engine] listening on :${cfg.port}`));

  if (await wa.hasSavedSession()) {
    wa.start().catch((e) => console.error('[wa] auto-start failed:', e.message));
  }

  const stop = async () => {
    console.log('[engine] shutting down');
    server.close();
    await engine.shutdown();
    await store.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
}

main().catch((e) => { console.error(e); process.exit(1); });
