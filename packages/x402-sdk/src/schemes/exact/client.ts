import { Address, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { getNetworkPassphrase } from '@x402/stellar';
import type { ClientStellarSigner, RpcConfig } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import type { PaymentRequirements } from '@x402/core/types';

/** @internal Native exact flow with a quote-bound guard at the actual signer boundary. */
export class ExactStellarClient extends ExactStellarScheme {
  readonly #signer: ClientStellarSigner;
  readonly #rpcConfig?: RpcConfig;

  constructor(signer: ClientStellarSigner, rpcConfig?: RpcConfig) {
    super(signer, rpcConfig);
    this.#signer = signer;
    this.#rpcConfig = rpcConfig;
  }

  override createPaymentPayload(...args: Parameters<ExactStellarScheme['createPaymentPayload']>) {
    const signer = this.#signer;
    // Each call owns its snapshot; asynchronous/concurrent signing cannot switch approved quotes.
    const approved = structuredClone(args[1]);
    const guarded: ClientStellarSigner = {
      address: signer.address,
      signAuthEntry: async (preimage, options) => {
        assertExactAuthorization(preimage, approved, signer.address);
        return signer.signAuthEntry(preimage, options);
      },
    };
    return new ExactStellarScheme(guarded, this.#rpcConfig).createPaymentPayload(...args);
  }
}

function assertExactAuthorization(preimage: string, quote: PaymentRequirements, payer: string) {
  let invocation: xdr.SorobanAuthorizedInvocation;
  try {
    const decoded = xdr.HashIdPreimage.fromXDR(preimage, 'base64');
    const type = decoded.switch().name;
    if (
      type !== 'envelopeTypeSorobanAuthorization' &&
      type !== 'envelopeTypeSorobanAuthorizationWithAddress'
    ) {
      throw new Error('Unsupported preimage');
    }
    const authorization =
      type === 'envelopeTypeSorobanAuthorization'
        ? decoded.sorobanAuthorization()
        : decoded.sorobanAuthorizationWithAddress();
    if (!authorization.networkId().equals(hash(Buffer.from(getNetworkPassphrase(quote.network))))) {
      throw new Error('Network mismatch');
    }
    if (
      type === 'envelopeTypeSorobanAuthorizationWithAddress' &&
      Address.fromScAddress(decoded.sorobanAuthorizationWithAddress().address()).toString() !==
        payer
    ) {
      throw new Error('Payer mismatch');
    }
    invocation = authorization.invocation();
  } catch {
    throw new Error('Invalid exact Buyer authorization preimage');
  }
  const expected = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(quote.asset).toScAddress(),
        functionName: 'transfer',
        args: [
          nativeToScVal(payer, { type: 'address' }),
          nativeToScVal(quote.payTo, { type: 'address' }),
          nativeToScVal(quote.amount, { type: 'i128' }),
        ],
      }),
    ),
    subInvocations: [],
  });
  if (invocation.toXDR('base64') !== expected.toXDR('base64')) {
    throw new Error('Exact Buyer authorization does not match the approved transfer');
  }
}
