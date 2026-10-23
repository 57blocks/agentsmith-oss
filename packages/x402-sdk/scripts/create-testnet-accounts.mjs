import { Keypair } from '@stellar/stellar-sdk';

// Usage: pnpm testnet:create-accounts
// Creates and funds one Seller and one Buyer testnet account, then prints the lines for
// .env.integration. Friendbot funds XLM only; the Buyer still needs testnet USDC to pay.

async function fundedTestnetAccount() {
  const keypair = Keypair.random();
  const friendbot = new URL('https://friendbot.stellar.org');
  friendbot.searchParams.set('addr', keypair.publicKey());
  const response = await fetch(friendbot);
  if (!response.ok) {
    throw new Error(`Friendbot failed (${response.status}): ${await response.text()}`);
  }
  return keypair;
}

const seller = await fundedTestnetAccount();
const buyer = await fundedTestnetAccount();

process.stdout.write(
  [
    'Created and funded TESTNET-ONLY accounts: one Seller recipient and one Buyer.',
    'Store the secrets securely; never commit them or send them to anyone.',
    `SELLER_ADDRESS=${seller.publicKey()}`,
    `BUYER_SECRET=${buyer.secret()}`,
    `# seller secret: ${seller.secret()}`,
    `# buyer address: ${buyer.publicKey()}`,
    '# The Buyer still needs testnet USDC to run paid journeys; friendbot funds XLM only.',
    '# SELLER_API_KEY is optional on testnet; obtain one with ApiKeyManager against a facilitator.',
    '',
  ].join('\n'),
);
