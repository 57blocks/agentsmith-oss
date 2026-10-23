import type { Migration } from 'kysely/migration';
import * as resourceServer from './0001_resource_server.js';
import * as apiCredentials from './0002_api_credentials.js';
import * as settlements from './0003_settlements.js';
import * as settlementsAfterSigning from './0004_settlements_after_signing.js';
import * as resourceServerEmail from './0005_resource_server_email.js';
import * as adminAudit from './0006_admin_audit.js';
import * as zeroUsageSettlement from './0007_zero_usage_settlement.js';
import * as registrationSource from './0008_registration_source.js';

/**
 * Every migration in apply order. Migrations are forward-only and never edited once merged; a
 * schema change is a new file. Listed statically so the compiled image needs no directory scan.
 */
export const migrations: Record<string, Migration> = {
  '0001_resource_server': resourceServer,
  '0002_api_credentials': apiCredentials,
  '0003_settlements': settlements,
  '0004_settlements_after_signing': settlementsAfterSigning,
  '0005_resource_server_email': resourceServerEmail,
  '0006_admin_audit': adminAudit,
  '0007_zero_usage_settlement': zeroUsageSettlement,
  '0008_registration_source': registrationSource,
};
