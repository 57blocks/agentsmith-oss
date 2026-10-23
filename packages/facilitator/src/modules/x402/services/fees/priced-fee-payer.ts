import { FeeBumpTransaction, TransactionBuilder } from '@stellar/stellar-sdk';
import type { FacilitatorStellarSigner } from '@x402/stellar';
import type { FeeBumpBid } from './fee-bump-bid.js';

const SIGNING_REFUSED = -1;

/**
 * The fee payer as the schemes see it: each fee-bump it is asked to sign is rebuilt around the
 * same signed inner transaction at the current bid, then signed. Both upstream `exact` and `upto`
 * submit the envelope a signer returns, so this one place prices every settlement. Anything that
 * is not a fee-bump paid by this fee payer, or cannot be rebuilt, is refused, never signed.
 */
export function withFeeBumpBid(
  signer: FacilitatorStellarSigner,
  bid: Pick<FeeBumpBid, 'currentStroops'>,
  networkPassphrase: string,
): FacilitatorStellarSigner {
  const refuse = (message: string) => ({
    signedTxXdr: '',
    signerAddress: signer.address,
    error: { message, code: SIGNING_REFUSED },
  });
  return {
    ...signer,
    signTransaction: async (xdr, options) => {
      const passphrase = options?.networkPassphrase || networkPassphrase;
      let envelope;
      try {
        envelope = TransactionBuilder.fromXDR(xdr, passphrase);
      } catch {
        return refuse('the fee payer was given an envelope it cannot read');
      }
      if (!(envelope instanceof FeeBumpTransaction) || envelope.feeSource !== signer.address) {
        return refuse('the fee payer signs only fee-bumps it pays for');
      }
      const bidStroops = await bid.currentStroops();
      let priced;
      try {
        priced = TransactionBuilder.buildFeeBumpTransaction(
          signer.address,
          String(bidStroops),
          envelope.innerTransaction,
          passphrase,
        );
      } catch (error) {
        // A refusal, not a throw: nothing was signed, so the scheme can release its channel.
        const reason = error instanceof Error ? error.message : 'unknown';
        return refuse(`the fee-bump could not be rebuilt at ${bidStroops} stroops: ${reason}`);
      }
      return signer.signTransaction(priced.toXDR(), { ...options, networkPassphrase: passphrase });
    },
  };
}
