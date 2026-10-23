import { TransactionBuilder } from '@stellar/stellar-sdk';
import type { Kysely } from 'kysely';
import { getNetworkPassphrase, getRpcClient } from '@x402/stellar';
import { createDatabase, postgresDialect } from '../../../../common/database/database.js';
import type { Logger } from '../../../../common/logger.js';
import type { FacilitatorConfig } from '../../../../config/facilitator.config.js';
import type { Database } from '../../../../models/database.js';
import { SettlementRepository } from '../../repositories/settlement.repository.js';
import {
  PersistedSettlements,
  type EnvelopeSender,
  type TransactionStatusReader,
} from './persisted-settlements.js';
import { SettlementJournal } from './settlement-journal.js';

/** Database clock versus ledger close time; history must reach this far before the row. */
const HISTORY_SKEW_MS = 60_000;

/** Durable settlement records: the journal guards broadcasts, the records answer retries. */
export interface SettlementPersistence {
  /** The connection every durable record uses; credentials read through it too. */
  db: Kysely<Database>;
  journal: SettlementJournal;
  records: PersistedSettlements;
  close(): Promise<void>;
}

export interface SettlementPersistenceDeps {
  /** Replaces the PostgreSQL connection; tests pass an in-process database. */
  db?: Kysely<Database>;
  readStatus?: TransactionStatusReader;
  sendTransaction?: EnvelopeSender;
  now?: () => number;
}

export function createSettlementPersistence(
  config: FacilitatorConfig,
  log: Logger,
  deps: SettlementPersistenceDeps = {},
): SettlementPersistence {
  const db = deps.db ?? createDatabase(postgresDialect(config.databaseUrl));
  const repository = new SettlementRepository(db);
  const readStatus: TransactionStatusReader =
    deps.readStatus ??
    (async (hash) => {
      const response = await getRpcClient(config.network, { url: config.rpcUrl }).getTransaction(
        hash,
      );
      const { status, latestLedgerCloseTime, oldestLedgerCloseTime } = response;
      return { status, latestLedgerCloseTime, oldestLedgerCloseTime };
    });
  const passphrase = getNetworkPassphrase(config.network);
  const sendTransaction: EnvelopeSender =
    deps.sendTransaction ??
    (async (envelopeXdr) => {
      const envelope = TransactionBuilder.fromXDR(envelopeXdr, passphrase);
      await getRpcClient(config.network, { url: config.rpcUrl }).sendTransaction(envelope);
    });
  const records = new PersistedSettlements({
    settlements: repository,
    readStatus,
    sendTransaction,
    log,
    historySkewMs: HISTORY_SKEW_MS,
    now: deps.now,
  });
  return {
    db,
    journal: new SettlementJournal(repository, passphrase, log, (channel, sequence) =>
      records.releaseSequence(channel, sequence),
    ),
    records,
    close: () => db.destroy(),
  };
}
