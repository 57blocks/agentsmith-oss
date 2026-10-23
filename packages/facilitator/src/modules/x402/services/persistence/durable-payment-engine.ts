import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import type { PaymentEngine } from '../engine/payment-engine.js';
import { authorizationIdentity } from './authorization-identity.js';
import type { JournalOutcome, SettlementDraft } from './settlement-journal.js';
import type { SettlementPersistence } from './settlement-persistence.js';
import type { Caller } from '../../../credentials/caller.js';

function invalidPayload(requirements: PaymentRequirements): SettleResponse {
  return {
    success: false,
    errorReason: 'invalid_payload',
    transaction: '',
    network: requirements.network,
  };
}

/** A zero-usage `upto` success: nothing was sent, so only a stored row makes it single-use. */
function isZeroUsage(draft: SettlementDraft, result: SettleResponse): boolean {
  return (
    result.success && !result.transaction && draft.scheme === 'upto' && draft.actualAmount === '0'
  );
}

function draftOf(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  resourceServerId: string,
): SettlementDraft | undefined {
  const identity = authorizationIdentity(payload, requirements);
  if (!identity) return undefined;
  return {
    resourceServerId,
    network: requirements.network,
    scheme: requirements.scheme === 'upto' ? 'upto' : 'exact',
    asset: requirements.asset,
    payTo: requirements.payTo,
    payer: identity.payer,
    signatureDigest: identity.signatureDigest,
    actualAmount: requirements.amount,
  };
}

/**
 * A payment engine whose settlements survive restarts and are shared by every instance. A resent
 * authorization is answered from its stored row without reaching the inner engine; a new one is
 * settled by the inner engine, whose fee payer must be guarded by the same journal.
 *
 * @throws when a signed settlement could not be stored; nothing was broadcast.
 */
export class DurablePaymentEngine implements PaymentEngine {
  constructor(
    private readonly inner: PaymentEngine,
    private readonly persistence: SettlementPersistence,
  ) {}

  verify(...args: Parameters<PaymentEngine['verify']>): ReturnType<PaymentEngine['verify']> {
    return this.inner.verify(...args);
  }

  supported(): ReturnType<PaymentEngine['supported']> {
    return this.inner.supported();
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    caller: Caller,
  ): Promise<SettleResponse> {
    const draft = draftOf(payload, requirements, caller.resourceServerId);
    if (!draft) return invalidPayload(requirements);
    const { records, journal } = this.persistence;
    const stored = await records.find(draft);
    if (stored) return records.answer(stored, draft);

    const { result, outcome } = await journal.run(draft, () =>
      this.inner.settle(payload, requirements, caller),
    );
    return this.resolve(draft, result, outcome);
  }

  private async resolve(
    draft: SettlementDraft,
    result: SettleResponse,
    outcome: JournalOutcome | undefined,
  ): Promise<SettleResponse> {
    const { records } = this.persistence;
    switch (outcome?.kind) {
      case 'recorded':
        await records.recordEngineResult(outcome.settlement, result);
        return result;
      case 'duplicate':
        return records.answer(outcome.settlement, draft);
      case 'store-failed':
        throw new Error('settlement could not be recorded');
      default:
        // Nothing was signed: a rejection, or a zero-usage settlement that sends no transaction.
        return isZeroUsage(draft, result) ? records.recordZeroUsage(draft, result) : result;
    }
  }
}
