import 'dotenv/config';
import { migrateDatabase } from './common/database/migrate.js';
import { logger } from './common/logger.js';
import { loadDatabaseUrl } from './config/facilitator.config.js';

// Process entry for `pnpm db:migrate` locally and `node dist/src/migrate.js` in a deployed task.
const databaseUrl = loadDatabaseUrl();
if (!databaseUrl) throw new Error('DATABASE_URL is required to run migrations');
logger.info('database_migrated', { applied: await migrateDatabase(databaseUrl) });
