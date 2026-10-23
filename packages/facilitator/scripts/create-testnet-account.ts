import { Keypair } from '@stellar/stellar-sdk';

// Usage: pnpm testnet:create-account [channels]   (default 1 channel)
const channelCount = Number(process.argv[2] ?? 1);
if (!Number.isSafeInteger(channelCount) || channelCount < 1) {
  throw new Error('The channel count must be a positive integer');
}

async function fundedTestnetAccount(): Promise<Keypair> {
  const keypair = Keypair.random();
  const friendbot = new URL('https://friendbot.stellar.org');
  friendbot.searchParams.set('addr', keypair.publicKey());
  const response = await fetch(friendbot);
  if (!response.ok) {
    throw new Error(`Friendbot failed (${response.status}): ${await response.text()}`);
  }
  return keypair;
}

const feePayer = await fundedTestnetAccount();
const channels: Keypair[] = [];
for (let i = 0; i < channelCount; i += 1) channels.push(await fundedTestnetAccount());
// The upto authorization signer (F_AUTH): a distinct account Buyers authorize, separate from the
// fee payer and every channel. Random keys never collide, so distinctness holds.
const uptoAuthorization = await fundedTestnetAccount();

process.stdout.write(
  [
    `Created and funded TESTNET-ONLY accounts: one fee payer, ${channelCount} channel(s), one upto authorization key.`,
    'Store the secrets in a secret manager; never commit them or send them to a buyer.',
    `FACILITATOR_STELLAR_FEE_BUMP_SECRET=${feePayer.secret()}`,
    `FACILITATOR_STELLAR_CHANNEL_SECRETS=${channels.map((channel) => channel.secret()).join(',')}`,
    `FACILITATOR_STELLAR_PRIVATE_KEY=${uptoAuthorization.secret()}`,
    `# fee payer:      ${feePayer.publicKey()}`,
    `# channels:       ${channels.map((channel) => channel.publicKey()).join(',')}`,
    `# upto auth:      ${uptoAuthorization.publicKey()}`,
    '',
  ].join('\n'),
);
