import type { AdminAuditTable } from './credentials/admin-audit.model.js';
import type { ApiCredentialTable } from './credentials/api-credential.model.js';
import type { RegistrationSourceTable } from './credentials/registration-source.model.js';
import type { ResourceServerTable } from './credentials/resource-server.model.js';
import type { SettlementTable } from './x402/settlement.model.js';

/** Every table, keyed by its camelCase name; `CamelCasePlugin` maps it to snake_case SQL. */
export interface Database {
  resourceServer: ResourceServerTable;
  apiCredentials: ApiCredentialTable;
  settlements: SettlementTable;
  adminAudit: AdminAuditTable;
  registrationSource: RegistrationSourceTable;
}
