import { StrKey } from '@stellar/stellar-sdk';
import { x402Client } from '@x402/core/client';
import { ExactStellarClient } from '../schemes/exact/client.js';
import { isClientStellarSigner, isStellarNetwork } from '@x402/stellar';
import type { ClientStellarSigner } from '@x402/stellar';
import { UptoStellarClient } from '../schemes/upto/client.js';
import { isPositiveI128 } from '../schemes/amount.js';
import type { SchemeNetworkClient } from '@x402/core/types';
import type { BuyerFetchConfig } from './buyer-fetch.js';

/** @internal Native client settings after the public Buyer factory has constructed its signer. */
export interface PaymentClientConfig extends Pick<
  BuyerFetchConfig,
  'network' | 'rpcConfig' | 'schemes'
> {
  signer: ClientStellarSigner;
}

/** @internal Registers built-in schemes and SEP-41 amount policy on the native client. */
export function createPaymentClient(config: PaymentClientConfig): x402Client {
  if (!isStellarNetwork(config.network)) throw new TypeError('Unsupported Stellar network');
  if (
    !isClientStellarSigner(config.signer) ||
    !(
      StrKey.isValidEd25519PublicKey(config.signer.address) ||
      StrKey.isValidContract(config.signer.address)
    )
  ) {
    throw new TypeError('A Stellar authorization signer with a G or C address is required');
  }
  const client = new x402Client();
  for (const scheme of selectedSchemes(config)) client.register(config.network, scheme);
  // Disable upstream default-token membership and USD limits; token acceptance is not a catalog.
  client.setSpendControls(false);
  return client.registerPolicy((_version, requirements) =>
    requirements.filter(
      (requirement) =>
        StrKey.isValidContract(requirement.asset) && isPositiveI128(requirement.amount),
    ),
  );
}

function selectedSchemes(config: PaymentClientConfig): SchemeNetworkClient[] {
  const names = config.schemes ?? ['exact', 'upto'];
  if (
    names.length === 0 ||
    new Set(names).size !== names.length ||
    names.some((name) => name !== 'exact' && name !== 'upto')
  ) {
    throw new TypeError('Configure unique exact or upto scheme names');
  }
  return names.map((name) =>
    name === 'exact'
      ? new ExactStellarClient(config.signer, config.rpcConfig)
      : new UptoStellarClient(config.signer, config.rpcConfig),
  );
}
