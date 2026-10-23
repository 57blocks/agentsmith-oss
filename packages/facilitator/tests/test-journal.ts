import { Networks } from '@stellar/stellar-sdk';
import type { FacilitatorStellarSigner } from '@x402/stellar';
import {
  DummyDriver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type Dialect,
} from 'kysely';
import { createDatabase } from '../src/common/database/database.js';
import { SettlementRepository } from '../src/modules/x402/repositories/settlement.repository.js';
import { SettlementJournal } from '../src/modules/x402/services/persistence/settlement-journal.js';

/** PostgreSQL SQL over a driver that runs nothing and returns no rows. */
const noDatabase: Dialect = {
  createAdapter: () => new PostgresAdapter(),
  createDriver: () => new DummyDriver(),
  createIntrospector: (db) => new PostgresIntrospector(db),
  createQueryCompiler: () => new PostgresQueryCompiler(),
};

const NOT_SIGNED = { message: 'the test journal refuses the fee payer signature', code: -1 };

/**
 * The journal's guard passes a signature through outside `journal.run`, which only the durable
 * engine enters, so this one refuses the fee payer outright: a test that reaches it sees a signing
 * failure, and nothing it signs can be broadcast.
 */
class RefusingJournal extends SettlementJournal {
  override guardFinalSigner(signer: FacilitatorStellarSigner): FacilitatorStellarSigner {
    return { ...signer, signTransaction: async () => ({ signedTxXdr: '', error: NOT_SIGNED }) };
  }
}

/** A journal with no database behind it, for engine tests whose schemes never sign. */
export function journalWithoutDatabase(): SettlementJournal {
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  return new RefusingJournal(
    new SettlementRepository(createDatabase(noDatabase)),
    Networks.TESTNET,
    log,
  );
}
