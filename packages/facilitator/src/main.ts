import 'dotenv/config';
import { createApp } from './app.js';
import { migrateDatabase } from './common/database/migrate.js';
import { loadConfig } from './config/facilitator.config.js';
import { logger } from './common/logger.js';

const config = loadConfig();
// The schema is brought up to date before serving; an unreachable database stops startup instead of
// failing every settlement later.
try {
  logger.info('database_migrated', { applied: await migrateDatabase(config.databaseUrl) });
} catch (error) {
  // The driver's message (host lookup, TLS, authentication) names the cause, never the password.
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  logger.error('database_unavailable', {
    errorName: cause instanceof Error ? cause.name : 'unknown',
    reason: cause instanceof Error ? cause.message : 'unknown',
  });
  process.exit(1);
}
const app = await createApp({ config, log: logger });
await app.listen(config.port, config.host);
logger.info('facilitator_listening', {
  host: config.host,
  port: config.port,
  network: config.network,
});

async function shutdown(signal: string) {
  logger.info('shutdown_started', { signal });
  const forced = setTimeout(() => {
    logger.error('shutdown_timeout', { timeoutMs: config.shutdownTimeoutMs });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forced.unref();
  try {
    await app.close();
    clearTimeout(forced);
    logger.info('shutdown_complete');
    process.exit(0);
  } catch (error) {
    clearTimeout(forced);
    logger.error('shutdown_failed', { reason: error instanceof Error ? error.message : 'unknown' });
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
