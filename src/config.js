'use strict';
const path = require('path');

function load(env = process.env) {
  const token = env.ENGINE_API_TOKEN || '';
  const secret = env.ENGINE_SECRET || '';
  const errors = [];
  if (token.length < 24) errors.push('ENGINE_API_TOKEN must be at least 24 characters');
  if (secret.length < 24) errors.push('ENGINE_SECRET must be at least 24 characters');
  return {
    port: parseInt(env.PORT || '3000', 10),
    token,
    secret,
    databaseUrl: env.DATABASE_URL || '',
    dbSsl: env.DB_SSL ? env.DB_SSL !== 'false' : null,
    dataDir: env.DATA_DIR || path.join(process.cwd(), 'data'),
    errors,
  };
}

module.exports = { load };
