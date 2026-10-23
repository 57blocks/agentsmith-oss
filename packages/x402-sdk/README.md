# AgentSmith SDK

Stellar x402 payment integration for Sellers and Buyers. Sellers gate API routes behind a 402
challenge; Node Buyers use native signing and paid fetch, with optional application confirmation.
The Seller connects to the Facilitator for verification/settlement; the Buyer calls the Seller and
Stellar RPC rather than the Facilitator directly.

Registers `exact` (fixed charge per request) and local experimental `upto` (Buyer authorizes a
ceiling; Facilitator settles actual usage) for `stellar:testnet` or `stellar:pubnet`. Token support
is not restricted to USDC or an asset list; explicit prices use SEP-41 contract addresses and
atomic integer strings. Upto signs against the SDK-pinned Kernel for the network.

## Installation

Build from the AgentSmith repository:

```sh
pnpm install --frozen-lockfile
pnpm --filter agentsmith-x402-sdk build
```

The SDK consumes official x402 packages without dependency patches. External applications
install the package normally; no patch directory or package-manager patch configuration is required.

```sh
npm install agentsmith-x402-sdk
```

For Seller Express or Nest with the Express adapter, install the optional peers:

```sh
npm install express @x402/express@2.23.0
```

For development, add to your project from a local checkout:

```sh
pnpm add /absolute/path/to/agentsmith/packages/x402-sdk
```

Within the same pnpm workspace use `agentsmith-x402-sdk@workspace:*`. Requires Node 24+ and ES
modules (`"type": "module"` in `package.json`).

Optional peer dependencies — install when using the Express entry:

```sh
pnpm add express@5 @x402/express@2 @x402/core@2
pnpm add -D @types/express
```

## Testnet setup

Requires Node.js 24+ and the pnpm version pinned in the root `package.json`. From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile        # run from the repository root
cd packages/x402-sdk
pnpm testnet:create-accounts          # creates and funds a Seller and a Buyer on testnet
cp .env.integration.example .env.integration
# Put the printed SELLER_ADDRESS and BUYER_SECRET into .env.integration. The Buyer also needs
# testnet USDC to pay (friendbot funds XLM only); SELLER_API_KEY is optional on testnet (see API keys).
pnpm test                             # unit tests, no network
pnpm test:integration                 # builds, then signs and settles real testnet payments
```

## Package entries

| Entry                                | Exports                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `agentsmith-x402-sdk/seller`         | `createResourceServer`, `ApiKeyManager`, `UptoStellarServer`, error classes, types      |
| `agentsmith-x402-sdk/seller/express` | `createPaymentMiddleware`, `setSettlementOverrides`, types                              |
| `agentsmith-x402-sdk/buyer`          | `createBuyerFetch`, `createEd25519Signer`, `UptoStellarClient`, `x402HTTPClient`, types |

---

## Seller — Express / NestJS

### Quick start

```ts
import express from 'express';
import {
  createPaymentMiddleware,
  setSettlementOverrides,
} from 'agentsmith-x402-sdk/seller/express';

const app = express();

app.use(
  await createPaymentMiddleware({
    network: 'stellar:testnet',
    facilitator: { url: 'https://agentsmith.xyz/facilitator' },
    routes: {
      // exact: Buyer pays a fixed amount per request
      'GET /price': {
        accepts: {
          scheme: 'exact',
          payTo: process.env.SELLER_ADDRESS,
          price: { asset: process.env.TOKEN_CONTRACT, amount: '40000' },
          maxTimeoutSeconds: 60,
        },
        mimeType: 'application/json',
      },
      // upto: Buyer authorizes a ceiling; handler sets actual usage before responding
      'GET /metered': {
        accepts: {
          scheme: 'upto',
          payTo: process.env.SELLER_ADDRESS,
          price: { asset: process.env.TOKEN_CONTRACT, amount: '40000' },
          maxTimeoutSeconds: 60,
        },
        mimeType: 'application/json',
      },
    },
  }),
);

app.get('/price', (_req, res) => {
  res.json({ result: 'data' });
});

app.get('/metered', (_req, res) => {
  // Report actual atomic usage before responding; omission prevents settlement.
  setSettlementOverrides(res, { amount: '20000' });
  res.json({ result: 'data' });
});

app.listen(3000);
```

For `upto`, every successful handler must call `setSettlementOverrides(res, { amount })` before
responding. Missing usage, malformed, negative or over-cap amounts reject settlement; the SDK never
substitutes the ceiling. The original Buyer authorization keeps its maximum. An amount of `'0'`
closes the authorization without charging the Buyer: the Facilitator sends no transaction and
returns an empty `transaction`.

`amount` is an atomic token integer string. USDC on testnet has 7 decimals: `'10000000'` = 1 USDC.

### `createPaymentMiddleware` config

| Field                   | Type                                    | Required | Description                             |
| ----------------------- | --------------------------------------- | -------- | --------------------------------------- |
| `network`               | `'stellar:testnet' \| 'stellar:pubnet'` | Yes      | Stellar network; applied to every route |
| `facilitator.url`       | `string`                                | Yes      | Facilitator base URL                    |
| `facilitator.apiKey`    | `string`                                | Pubnet   | Bearer token; optional on testnet       |
| `facilitator.timeoutMs` | `number`                                | No       | Per-request timeout; default 45 000 ms  |
| `routes`                | `Record<string, PaymentRouteConfig>`    | Yes      | Paid route definitions                  |
| `paywallConfig`         | `PaywallConfig`                         | No       | Browser payment page settings           |
| `paywall`               | `PaywallProvider`                       | No       | Custom HTML payment page provider       |

Each route key is an x402 pattern (`GET /path`, `POST /api/*`). `accepts` may be a single option or
an array to offer multiple payment options for the same route. `maxTimeoutSeconds` controls how many
ledgers ahead the upto Buyer's authorization remains valid; Facilitator validation also applies. Omit
`network` per route — it is inherited from the top-level config. facilitator.timeoutMs bounds
Facilitator HTTP attempts; it is not a business-handler deadline. Configure handler deadlines
and payment-header CORS in the application.

### `createResourceServer`

Use this lower-level entry when you need the native `x402ResourceServer` directly — for example to
compose your own HTTP framework adapter or register native lifecycle hooks:

```ts
import { createResourceServer } from 'agentsmith-x402-sdk/seller';

const server = await createResourceServer({
  network: 'stellar:testnet',
  facilitator: { url: 'https://agentsmith.xyz/facilitator' },
  schemes: ['exact', 'upto'], // default: ['exact']
});
```

`createResourceServer` fetches Facilitator capabilities before returning and validates that all
configured schemes are supported. Upto metadata must advertise a G-address Facilitator signer,
because the current Buyer flow also uses it as transaction source. This differs from the Kernel
C-address. Throws `ResourceServerInitializationError` on connectivity failure
and `TypeError` for configuration or capability errors.

Custom adapters using `createResourceServer` must enforce explicit upto actual usage through
their native integration before settlement. The Express convenience helper installs this guard
automatically; a bare resource server does not infer business usage.

### API keys

Pubnet needs a Facilitator API key; testnet works without one. On testnet a key you pass is sent
and checked, so you can try the whole key lifecycle there. Get a key with `ApiKeyManager`. It needs
no key itself and sends nothing until you call a method.

```ts
import { ApiKeyManager } from 'agentsmith-x402-sdk/seller';

const keys = new ApiKeyManager({ facilitatorUrl: 'https://agentsmith.xyz/facilitator' });

// Once per Resource Server. The domain is a bare host name and can be registered only once.
const { apiKey } = await keys.createApiKey({
  name: 'Weather API',
  domain: 'weather.example.com',
  email: 'ops@example.com',
});

// Replace a key. The old one keeps working for ten minutes while you deploy the new one.
const { apiKey: next } = await keys.rotateApiKey(apiKey);

// Revoke the presented key at once.
await keys.revokeApiKey(next);
```

The key is shown only in the return value. Store it in your secret manager; the SDK never logs or
saves it. Registration is limited per IP (five per hour by default).

Errors:

- `ApiKeyRequestError`: the Facilitator refused and nothing changed. Read `status` and `code`
  (`INVALID_REQUEST`, `DOMAIN_TAKEN`, `RATE_LIMITED` with `retryAfterSeconds`, `UNAUTHORIZED`,
  `NOT_CURRENT_KEY`, `CREDENTIAL_STORE_UNAVAILABLE`).
- `ApiKeyOutcomeUnknownError`: a timeout, a network error or a gateway error. The request may have
  succeeded. Do not resend it: a second registration gets `DOMAIN_TAKEN`, and a second rotation
  with the old key gets `NOT_CURRENT_KEY`. Ask the Facilitator operator to issue a new key for your
  domain.

Only the newest key can rotate. Revoking your only key also needs the operator to issue a new one.

### NestJS

A NestJS application using the Express adapter mounts the middleware in bootstrap:

```ts
import { NestFactory } from '@nestjs/core';
import { createPaymentMiddleware } from 'agentsmith-x402-sdk/seller/express';
import { AppModule } from './app.module.js';

const app = await NestFactory.create(AppModule);
app.setGlobalPrefix('api');
app.use(
  await createPaymentMiddleware({
    network: 'stellar:testnet',
    facilitator: { url: 'https://agentsmith.xyz/facilitator' },
    routes: {
      'GET /api/weather': {
        accepts: {
          scheme: 'exact',
          payTo: process.env.SELLER_ADDRESS,
          price: { asset: process.env.TOKEN_CONTRACT, amount: '40000' },
        },
      },
    },
  }),
);
await app.listen(3000);
```

Route patterns must include the global prefix. This integration is for Nest's Express adapter; it is
not compatible with the Fastify adapter.

### Request lifecycle

1. An unpaid request receives `402` with payment terms; the business handler does not execute.
2. The Buyer signs the terms and retries with `PAYMENT-SIGNATURE`.
3. x402 verifies payment through the Facilitator before executing the handler.
4. After a successful handler response, x402 settles and returns the business result with the
   `PAYMENT-RESPONSE` receipt.

Business handlers do not call verify/settle manually. Business side effects cannot be rolled back by
a failed settlement; account for retries and uncertain outcomes in application logic. Handler
responses explicitly set with res.status(400/500) do not settle. Set the status before json/end
or writeHead; the native adapter reads statusCode before replaying buffered writes. Successful
responses explicitly set with res.status(200/201) follow the normal native settlement path.

---

## Buyer — Node

Buyer signing uses a local Ed25519 G-account signer. C-account Buyers and browser wallet
adapters are not supported. The application owns the secret seed and key storage.

### `createBuyerFetch` — drop-in paid fetch

A paid `fetch` that handles 402 challenges, signs payments, and retries automatically:

```ts
import { createBuyerFetch } from 'agentsmith-x402-sdk/buyer';

const paidFetch = createBuyerFetch({
  secret: process.env.STELLAR_SECRET,
  network: 'stellar:testnet',
});

const response = await paidFetch('https://seller.example.com/price', {
  signal: AbortSignal.timeout(90000),
});
const data = await response.json();
```

The wrapper handles 402 challenges, payment creation, signing, and resend. No manual auth-entry
construction or RPC calls are needed in the application. Before exact signing, the SDK checks the
actual authorization preimage against the approved token, payer, recipient, amount and network,
rejecting extra sub-invocations. This keeps arbitrary SEP-41 token support without signing unrelated calls.

#### Payment approval confirmation

```ts
const paidFetch = createBuyerFetch({
  secret: process.env.STELLAR_SECRET,
  network: 'stellar:testnet',
  onBeforePaymentCreation: async ({ selectedRequirements }) => {
    const approved = await showPaymentDialog(selectedRequirements);
    if (!approved) return { abort: true, reason: 'User rejected payment' };
    // resolve void to approve
  },
});
```

`onBeforePaymentCreation` is called after the Seller's 402 challenge and before signing. Return
`{ abort: true, reason }` to stop without signing. For `upto` the `amount` in `selectedRequirements`
is the ceiling the Buyer authorizes, not the final charge.

#### `BuyerFetchConfig`

| Field                      | Type                                    | Required | Description                                                                            |
| -------------------------- | --------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `secret`                   | `string`                                | Yes      | Stellar secret seed; application owns key storage                                      |
| `network`                  | `'stellar:testnet' \| 'stellar:pubnet'` | Yes      | Stellar network                                                                        |
| `rpcConfig`                | `RpcConfig`                             | No       | Custom Stellar RPC endpoint; pubnet requires a URL                                     |
| `schemes`                  | `('exact' \| 'upto')[]`                 | No       | Schemes to enable; default `['exact', 'upto']`                                         |
| `onPaymentRequired`        | hook                                    | No       | Called on initial 402; return `{ headers }` to retry before payment                    |
| `onBeforePaymentCreation`  | hook                                    | No       | Called before signing; return `{ abort: true }` to cancel                              |
| `onAfterPaymentCreation`   | hook                                    | No       | Called after payload creation, before sending                                          |
| `onPaymentCreationFailure` | hook                                    | No       | Called on signing failure; return `{ recovered: true, payload }` to recover            |
| `onPaymentResponse`        | hook                                    | No       | Called after paid response; return `{ recovered: true }` to retry with a fresh payment |

All hooks are optional. Omitting `onBeforePaymentCreation` enables automatic signing with no
per-payment dialog — suitable for autonomous agents. The native client is private: this factory
does not expose policy/selector registration. It chooses the first eligible registered quote after
contract-address/positive-i128 format checks. Use the before hook to approve/reject selected terms;
advanced selection uses upstream native composition.

For `upto`, the Buyer signs against the SDK-pinned Kernel for the network; there is nothing to
configure. A Facilitator advertising any other `settlementContract` is refused, and the full Buyer
authorization tree is checked before signing. The pinned Kernel does not restrict which SEP-41 tokens
can be paid.

```ts
const paidFetch = createBuyerFetch({
  secret,
  network: 'stellar:testnet',
});
```

The five hooks preserve native ordering and recovery. After creation does not confirm settlement;
creation-failure hooks do not catch approval rejection or paid-request transport errors. A response
hook only runs for a received paid response, and the receipt may be absent. Explicit recovery can
create a fresh payment and repeat business execution; applications own that decision and idempotency.

### `UptoStellarClient` — bring your own signer

The scheme accepts the native ClientStellarSigner contract for independent upstream composition.
Use a G-account signer with Stellar authorization-signing semantics, as in this Node example.

```ts
import { UptoStellarClient, createEd25519Signer } from 'agentsmith-x402-sdk/buyer';

import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';

const signer = createEd25519Signer(secret, 'stellar:testnet');
const client = new x402Client();
// The trusted Kernel is pinned in the SDK per network; the Seller quote cannot change it.
client.register('stellar:testnet', new UptoStellarClient(signer));
// Opt out of upstream default-token/USD controls if the application intends to pay any SEP-41 token.
client.setSpendControls(false);
const paidFetch = wrapFetchWithPayment(fetch, client);
const response = await paidFetch(url);
```

`signAuthEntry` is called with the authorization preimage; key material never leaves the signer.

---

## Token amounts

All amounts are **atomic integer strings** matching the token contract's precision.

| Token            | Decimals         | 1 token                                      |
| ---------------- | ---------------- | -------------------------------------------- |
| USDC (testnet)   | 7                | `'10000000'`                                 |
| Arbitrary SEP-41 | contract-defined | use the contract address and its atomic unit |

`price.asset` is the SEP-41 token contract address. `price.amount` is an atomic integer string.
With explicit asset/amount prices, the SDK does not resolve symbols, infer decimals or perform
USD conversion. Native Money-style prices still use upstream default-asset conversion; use explicit
asset/amount prices for arbitrary SEP-41 tokens. No arbitrary-token decimal conversion helper is provided.

---

## Current error behavior

The Express helper retains native x402 2.23.0 outcomes: invalid payment receives a 402 challenge;
settlement failure defaults to 402 with PAYMENT-RESPONSE and an empty body, unless native route
configuration supplies a failure body. A structured pending result does not receive a special SDK
503 status. Malformed Facilitator responses and timeouts produce 502 with sanitized transport
messages. Initialization errors are thrown to the application.

`ResourceServerInitializationError.cause` contains a sanitized Facilitator error. Timeout causes
retain `operation` and `timeoutMs`; transport causes retain `operation` and, when recognized, a
network `code` such as `ENOTFOUND`, `ECONNREFUSED` or `CERT_HAS_EXPIRED`. Raw messages, response
bodies and credentials are excluded. Unknown failures keep a generic cause. HTTP status is not
inferred from error messages when upstream provides no structured status.

Read native receipts and retain payment uncertainty in application logic. There is no SDK outcome
classifier or automatic business recovery. A missing receipt or transport error after sending a
paid request does not prove that no charge occurred.
