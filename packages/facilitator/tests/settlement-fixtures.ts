import { randomBytes } from 'node:crypto';
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';

export const asset = StrKey.encodeContract(randomBytes(32));
export const payTo = Keypair.random().publicKey();

export interface BuyerAuthorization {
  buyer?: string;
  nonce?: bigint;
  /** A contract account may sign with any value, including none. */
  signature?: xdr.ScVal;
  amount?: bigint;
  /** The transaction source; a random account by default. */
  source?: string;
}

/** Transaction preconditions a Buyer can set besides its time bounds. */
export type BuyerPreconditions = Pick<
  NonNullable<ConstructorParameters<typeof TransactionBuilder>[1]>,
  | 'ledgerbounds'
  | 'minAccountSequence'
  | 'minAccountSequenceAge'
  | 'minAccountSequenceLedgerGap'
  | 'extraSigners'
>;

/** A Buyer's `exact` payment transaction: `transfer(buyer, payTo, amount)` with its auth entry. */
export function exactPaymentXdr(
  auth: BuyerAuthorization = {},
  preconditions: BuyerPreconditions = {},
): string {
  const buyer = auth.buyer ?? Keypair.random().publicKey();
  const args = [
    nativeToScVal(buyer, { type: 'address' }),
    nativeToScVal(payTo, { type: 'address' }),
    nativeToScVal(auth.amount ?? 10_000n, { type: 'i128' }),
  ];
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(buyer).toScAddress(),
        nonce: new xdr.Int64(auth.nonce ?? 1n),
        signatureExpirationLedger: 1_000,
        signature: auth.signature ?? xdr.ScVal.scvBytes(randomBytes(64)),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(asset).toScAddress(),
          functionName: 'transfer',
          args,
        }),
      ),
      subInvocations: [],
    }),
  });
  return new TransactionBuilder(new Account(auth.source ?? Keypair.random().publicKey(), '0'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
    ...preconditions,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: asset,
        function: 'transfer',
        args,
        auth: [entry],
      }),
    )
    .setTimeout(60)
    .build()
    .toXDR();
}

/** An unsigned fee-bump around a channel-signed transaction, as the fee payer receives it. */
export function unsignedFeeBump(
  channel: Keypair,
  feePayerAddress: string,
  sequence = '41',
  timeoutSeconds = 60,
): string {
  const inner = new TransactionBuilder(new Account(channel.publicKey(), sequence), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: '0' }))
    .setTimeout(timeoutSeconds)
    .build();
  inner.sign(channel);
  return TransactionBuilder.buildFeeBumpTransaction(
    feePayerAddress,
    '200',
    inner,
    Networks.TESTNET,
  ).toXDR();
}

/** The Kernel terms a Buyer signs for `upto`; amounts are in the asset's atomic units. */
export interface UptoTerms {
  payer: string;
  asset: string;
  payTo: string;
  facilitator: string;
  maxAmount: bigint;
  validAfterLedger: number;
  deadlineLedger: number;
}

export interface UptoPaymentOptions {
  terms?: Partial<UptoTerms>;
  /** The Kernel's amount argument; the Buyer signs it at the maximum. */
  actual?: bigint;
  /** The transaction source; a random account by default. */
  source?: string;
  operationSource?: string;
  method?: string;
  /** Replaces the `(terms, actual)` arguments. */
  args?: xdr.ScVal[];
  /** Replaces the Buyer's single authorization, which expires at the deadline. */
  auth?: readonly xdr.SorobanAuthorizationEntry[];
  preconditions?: BuyerPreconditions;
}

/** An address-credential authorization of a call to `kernel.settle`. */
export function uptoAuthEntry(
  kernel: string,
  address: string,
  expirationLedger: number,
  args: xdr.ScVal[] = [],
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(),
        nonce: new xdr.Int64(1n),
        signatureExpirationLedger: expirationLedger,
        signature: xdr.ScVal.scvBytes(randomBytes(64)),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(kernel).toScAddress(),
          functionName: 'settle',
          args,
        }),
      ),
      subInvocations: [],
    }),
  });
}

function uptoTermsScVal(terms: UptoTerms): xdr.ScVal {
  const address = (value: string) => nativeToScVal(value, { type: 'address' });
  const entry = (key: string, val: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  return xdr.ScVal.scvMap([
    entry('asset', address(terms.asset)),
    entry('deadline_ledger', xdr.ScVal.scvU32(terms.deadlineLedger)),
    entry('facilitator', address(terms.facilitator)),
    entry('max_amount', nativeToScVal(terms.maxAmount, { type: 'i128' })),
    entry('pay_to', address(terms.payTo)),
    entry('payer', address(terms.payer)),
    entry('valid_after_ledger', xdr.ScVal.scvU32(terms.validAfterLedger)),
  ]);
}

/** A Buyer's `upto` payment: the Kernel's `settle(terms, actual)` with its auth entry. */
export function uptoPaymentXdr(
  kernel: string,
  facilitator: string,
  options: UptoPaymentOptions = {},
): string {
  const terms: UptoTerms = {
    payer: Keypair.random().publicKey(),
    asset,
    payTo,
    facilitator,
    maxAmount: 10_000n,
    validAfterLedger: 0,
    deadlineLedger: 2_000,
    ...options.terms,
  };
  const termsVal = uptoTermsScVal(terms);
  const actual = nativeToScVal(options.actual ?? terms.maxAmount, { type: 'i128' });
  const auth = options.auth ?? [
    uptoAuthEntry(kernel, terms.payer, terms.deadlineLedger, [termsVal]),
  ];
  return new TransactionBuilder(new Account(options.source ?? Keypair.random().publicKey(), '0'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
    ...options.preconditions,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: kernel,
        function: options.method ?? 'settle',
        args: options.args ?? [termsVal, actual],
        auth: [...auth],
        source: options.operationSource,
      }),
    )
    .setTimeout(60)
    .build()
    .toXDR();
}
