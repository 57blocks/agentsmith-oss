# AgentSmith Stellar Facilitator

A standalone, self-hosted x402 v2 Facilitator for fee-sponsored Stellar payments. It exposes `GET /supported`, `POST /verify`, and `POST /settle`. The `exact` path delegates authorization validation and settlement to the Apache-2.0 `@x402/stellar` package. The optional Kernel-backed `upto` path is an experimental local adapter and is not yet an upstream x402 scheme. No Resource Server, Bazaar deployment, or other AgentSmith service is required to start this process.

The HTTP service runs on NestJS with the Express platform, organized by feature module. The external x402 routes and response formats follow the x402 v2 specification.

## Payment path

```text
Buyer -> Resource server: request
Buyer <- Resource server: 402 + PAYMENT-REQUIRED
Buyer -> Resource server: retry + PAYMENT-SIGNATURE
Resource server -> Facilitator: POST /verify
Resource server: invoke the HTTP endpoint or MCP tool
Resource server -> Facilitator: POST /settle
Facilitator -> Stellar RPC: simulate, sign fee-sponsored tx, submit, confirm
Buyer <- Resource server: result + PAYMENT-RESPONSE settlement hash
```

The buyer signs a Soroban authorization entry for one SEP-41 `transfer(from, to, amount)` call. The Facilitator sources the transaction and pays the XLM network fee, but it cannot change the asset, recipient, or amount without invalidating the buyer's authorization. It is not a custodian and is never the source of payment funds.

## Testnet quick start

Requires Node.js 24+ and the pnpm version pinned in the root `package.json`. Install from the
repository root, then run service commands from `packages/facilitator/`. The default configuration serves `stellar:testnet` and advertises `exact` and experimental `upto`; `upto` uses the pre-deployed testnet Kernel, so no Kernel deployment is required.

```bash
corepack enable
pnpm install --frozen-lockfile  # run from the repository root
cd packages/facilitator
pnpm testnet:create-account     # a fee payer, one channel, and an upto authorization key; pass a number for more channels
cp .env.example .env
# Put the three printed FACILITATOR_STELLAR_* lines into .env. The example's DATABASE_URL and
# CHANNEL_STORE_URL already point at the compose services started below.
pnpm test
pnpm build
docker compose up -d postgres valkey
pnpm start
```

The fee payer must hold enough XLM to sponsor transaction fees; channels need only their minimum balance. For production, use a separately managed key and secret store; do not use Friendbot or commit `.env`.

Alternatively, after creating `.env`, run `docker compose up --build -d`. Compose publishes port 8407 only on the host's loopback interface. Run a separate instance and config for pubnet.

### Local Valkey

Every instance leases its channels from a Redis-protocol store (`CHANNEL_STORE_URL`, required).
Compose runs one locally, published on loopback only, with append-only persistence in the
`valkey-data` volume; the facilitator container waits for it. Start it before `pnpm dev`. Create
`.env` first (see above): Compose reads the facilitator's `env_file` for `exec` and `down` even when
only Valkey is running.

```bash
docker compose up -d valkey
docker compose exec valkey valkey-cli ping          # PONG
docker compose down -v                              # stop and delete its data
```

The channel-store integration tests run against it, in database 15, which they flush; they are not
part of `pnpm check` and fail rather than skip when no store is configured:

```bash
CHANNEL_STORE_URL=redis://127.0.0.1:6379/15 pnpm --filter @agentsmith/stellar-facilitator test:integration
```

The e2e tests call a deployed facilitator over HTTP and pay with testnet XLM from accounts friendbot
creates for the run. They refuse a target that advertises any network but `stellar:testnet`, and the
pool test needs `E2E_CHANNEL_COUNT` equal to the deployment's channel count. CI runs them after every
develop deployment:

```bash
E2E_FACILITATOR_URL=https://devnet.agentsmith.xyz/facilitator E2E_CHANNEL_COUNT=2 \
  pnpm --filter @agentsmith/stellar-facilitator test:e2e
```

Check the local authenticated interface:

```bash
curl http://localhost:8407/health
curl http://localhost:8407/supported   # testnet; on pubnet add -H "Authorization: Bearer <your API key>"
```

The OpenAPI document is at `/docs-json` and its Swagger UI at `/docs`, on every environment (for example `https://devnet.agentsmith.xyz/facilitator/docs`). It covers every route except `/admin`. For the x402 bodies the x402 v2 specification is normative.

`/supported` must advertise `x402Version: 2`, `scheme: exact`, `network: stellar:testnet`, and `extra.areFeesSponsored: true`. When `X402_UPTO_KERNEL_CONTRACT` is set, it also advertises experimental `scheme: upto` and the public settlement contract. Point a resource server at `http://localhost:8407`; it is the resource server—not the buyer/browser—that calls `/verify` and `/settle`.

## Configuration

| Variable                                | Default                                                | Purpose                                                                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACILITATOR_STELLAR_PRIVATE_KEY`       | required for `upto` (`env` mode)                       | Fixed `upto` authorization signer (F_AUTH); must differ from the fee payer and every channel                                                                                                                               |
| `STELLAR_NETWORK`                       | `stellar:testnet`                                      | One process serves `stellar:testnet` or `stellar:pubnet`                                                                                                                                                                   |
| `STELLAR_RPC_URL`                       | SDF testnet RPC                                        | Soroban JSON-RPC endpoint                                                                                                                                                                                                  |
| `MAX_RESOURCE_FEE_STROOPS`              | `60000`                                                | Cap on a payment's simulated resource fee, which the Buyer's transaction determines; a payment above it is refused. The fee-bump bid is capped separately                                                                  |
| `FEE_BUMP_BID_MULTIPLIER`               | `1.5`                                                  | Each fee-bump bids the network's recent median Soroban inclusion fee (`getFeeStats`) times this, per operation. A bid over 30 s old is read again first, waiting at most 2 s; a failed or slow read keeps the last bid     |
| `MAX_FEE_BUMP_BID_STROOPS`              | `2000`                                                 | Cap on the fee-bump bid per operation, at least 100; half of it (at least 100) is bid while no fee read has succeeded. A settlement's worst-case fee is the resource ceiling plus twice this                               |
| `FACILITATOR_STELLAR_FEE_BUMP_SECRET`   | required (`env` mode)                                  | Fee payer: pays every network fee through a fee-bump; the only address `/supported` advertises                                                                                                                             |
| `FACILITATOR_STELLAR_CHANNEL_SECRETS`   | required (`env` mode)                                  | Comma-separated channel secrets; seeds an empty store, and signs for every member it derives                                                                                                                               |
| `X402_UPTO_KERNEL_CONTRACT`             | unset                                                  | Deployed Soroban Kernel (addresses below); enables the Stellar `upto` scheme                                                                                                                                               |
| `FACILITATOR_SIGNING_MODE`              | `env`                                                  | `env` signs with the seeds above (refused when `NODE_ENV=production`); `kms` signs with AWS KMS keys                                                                                                                       |
| `FACILITATOR_KMS_REGION`                | `AWS_REGION`                                           | KMS region (`kms` mode; one of the two is required)                                                                                                                                                                        |
| `FACILITATOR_KMS_FEE_PAYER_ADDRESS`     | required in `kms` mode                                 | G address of the fee-payer key                                                                                                                                                                                             |
| `FACILITATOR_KMS_CHANNEL_ADDRESSES`     | required in `kms` mode                                 | Comma-separated G addresses of the channel keys                                                                                                                                                                            |
| `FACILITATOR_KMS_AUTHORIZATION_ADDRESS` | required in `kms` mode with `upto`; refused without it | G address of the `upto` authorization key                                                                                                                                                                                  |
| `FACILITATOR_SECRETS`                   | unset                                                  | JSON object of string settings, e.g. a whole Secrets Manager value; its keys override variables of that name                                                                                                               |
| `DATABASE_URL`                          | required                                               | PostgreSQL connection string; the service does not start without it, and records every settlement there                                                                                                                    |
| `ADMIN_API_KEYS`                        | unset                                                  | JSON object of admin name to key (at least 32 characters each) for the `/admin` routes; unset means no admin                                                                                                               |
| `RATE_LIMIT_WINDOW_MS`                  | `60000`                                                | Window for the limit on `/supported`, `/verify` and `/settle`, counted per Resource Server (per IP without a valid key) in the channel store                                                                               |
| `RATE_LIMIT_MAX`                        | `120`                                                  | Requests allowed in that window; instances share the count, and a store outage limits nothing                                                                                                                              |
| `REGISTER_RATE_LIMIT_WINDOW_MS`         | `3600000`                                              | Window for the per-IP limit on `POST /credentials/register`                                                                                                                                                                |
| `REGISTER_RATE_LIMIT_MAX`               | `5`                                                    | Registrations allowed per IP in that window                                                                                                                                                                                |
| `REGISTRATION_IP_HASH_KEY`              | unset                                                  | HMAC key (at least 32 characters) for registration source IPs; set, each registration stores the IP's digest so the limit is counted in the database while the channel store is down; unset, a store outage limits nothing |
| `CHANNEL_STORE_URL`                     | required                                               | `redis://` or `rediss://` URL of the shared channel store; `rediss://` for a non-local store in production                                                                                                                 |
| `CHANNEL_STORE_COMMAND_TIMEOUT_MS`      | `500`                                                  | A store command slower than this fails, and the settlement with it                                                                                                                                                         |
| `CHANNEL_ACQUIRE_WAIT_MS`               | `3000`                                                 | How long a settlement waits for a free channel before failing as pool-full                                                                                                                                                 |
| `CHANNEL_COOLDOWN_MS`                   | `6000`                                                 | Rest after an included or refused transaction, before the channel is leased again                                                                                                                                          |
| `CHANNEL_UNKNOWN_MARGIN_MS`             | `30000`                                                | Added to a transaction's validity window when its outcome is unknown                                                                                                                                                       |
| `CHANNEL_LEASE_VERIFY_BUDGET_MS`        | `15000`                                                | Lease TTL: time allowed for verification                                                                                                                                                                                   |
| `CHANNEL_LEASE_POLL_OVERHEAD_PCT`       | `50`                                                   | Lease TTL: overhead of upstream `exact`'s confirmation polling over `maxTimeoutSeconds`                                                                                                                                    |
| `CHANNEL_LEASE_MARGIN_MS`               | `30000`                                                | Lease TTL: margin                                                                                                                                                                                                          |

The Soroban Kernel that `X402_UPTO_KERNEL_CONTRACT` names is built and deployed from [agentsmith-contracts](https://github.com/57blocks/agentsmith-contracts). The published deployments are [`CBB7WCIQOBOJ4G7JUPVOA3RI553HBSYQ3GLBJ25X7W7S7MRJIGVCXRE3`](https://stellar.expert/explorer/testnet/contract/CBB7WCIQOBOJ4G7JUPVOA3RI553HBSYQ3GLBJ25X7W7S7MRJIGVCXRE3) on testnet and [`CCV4RALFBEE2QLKPK6H5ZX24CYMKIFN3723J5J4TMDEFWAFLELGYODNI`](https://stellar.expert/explorer/public/contract/CCV4RALFBEE2QLKPK6H5ZX24CYMKIFN3723J5J4TMDEFWAFLELGYODNI) on pubnet.

`FACILITATOR_SECRETS` lets a platform inject one secret holding several settings, such as ECS injecting a whole Secrets Manager value. Any key is accepted, every value must be a JSON string, and a key it holds overrides a variable of the same name; settings it omits fall back to the variable, then to the default above. Invalid JSON stops startup without echoing the value.

Database migrations live in `src/migrations/` and are forward-only. Run `docker compose up -d postgres`, set `DATABASE_URL=postgres://facilitator:facilitator@127.0.0.1:5432/facilitator`, then `pnpm db:migrate`. The service also applies pending migrations at startup, before it listens, and exits with `database_unavailable` if the database cannot be reached or a migration fails; `node dist/src/migrate.js` runs them alone.

With `NODE_ENV=production`, a non-local `DATABASE_URL` must use `sslmode=verify-full`; startup fails otherwise. For RDS, point `sslrootcert` at `/app/certs/rds-global-bundle.pem`: the image ships the AWS global CA bundle there, pinned by checksum. Use separate database roles: the service role needs `SELECT`, `INSERT` and `UPDATE` only, never `DELETE` or DDL; migrations run as an owner role. Because startup migrates, a deployment that uses one role gives it `CREATE` on the schema.

Resource Server API keys live in the database (`api_credentials`); there is no shared key. Pubnet requires one on `/supported`, `/verify` and `/settle`. Testnet serves those routes without a key, so anyone who can reach it can have its fee payer sponsor testnet payments, but checks a key that is sent; a wrong or revoked key gets 401. The default process and Docker Compose configuration bind port 8407 to loopback only: buyers call a separate paid Resource Server, while that server calls the Facilitator. If the Resource Server is on another host, connect it through a private network or authenticated proxy; do not publish this fee-sponsoring endpoint openly. Run separate testnet and pubnet instances because each scheme adapter is bound to one RPC/network pair.

**API keys (local extension, not x402).** `POST /credentials/register` with `{ name, domain, email }` returns a Resource Server's first key once; the domain must be a bare host name and is unique. With that key, `POST /credentials/keys/rotate` returns a new key and keeps the old one working for ten minutes, and `DELETE /credentials/keys/current` revokes the presented key. With a key from `ADMIN_API_KEYS`, `POST /admin/servers/:id/keys` issues a key for any active server (a disabled one gets 409 `SERVER_DISABLED`) and `DELETE /admin/keys/:id` revokes any key; each admin call that changes a key writes an `admin_audit` row naming the admin.

`exact` and `upto` lease channels from one pool shared by every instance on the same store (see [Channel pool](#channel-pool)). There is no single-signer mode: a configuration with only `FACILITATOR_STELLAR_PRIVATE_KEY` fails at startup. For `upto`, set the Resource Server's public `X402_FACILITATOR_ADDRESS` to the public key derived from `FACILITATOR_STELLAR_PRIVATE_KEY` (in `kms` mode, `FACILITATOR_KMS_AUTHORIZATION_ADDRESS`), not a channel or fee-bump address. A Buyer authorizes that fixed address; the selected channel sources the transaction, and the fee-bump account pays XLM. `maxTimeoutSeconds` is limited to 300 seconds to accept the current x402 server's default authorization window; `upto` waits at most 20 seconds for confirmation. If a transaction was broadcast but remains unconfirmed, `/settle` returns `success: false`, `errorReason: "settlement_pending"`, and the original non-empty transaction hash. Repeated settlement attempts in the same process reconcile that hash rather than submit on another channel. An RPC `NOT_FOUND` response does not release the channel or turn the payment into a confirmed failure. This is testnet-grade: pending state is lost on restart and is not shared across instances, so a retry that reaches another instance settles again.

## Channel pool

Every instance leases channels from the store, one settlement per channel at a time across all instances. `exact` leases before it verifies; `upto` leases after. A lease ends by what its transaction can still do: at once if nothing was sent, after `CHANNEL_COOLDOWN_MS` once the transaction is included, and only after the transaction can no longer be included when a node refused it or its outcome is unknown. A lease whose holder crashed expires on its own, after the lease TTL (495 s at `maxTimeoutSeconds = 300`). A refused broadcast is never signed again on another channel: its stored envelope is resent when the Resource Server retries the settlement, until it can no longer be included.

A settlement that finds no free channel within `CHANNEL_ACQUIRE_WAIT_MS` fails with `errorReason` `settle_exact_stellar_channel_unavailable` (`exact`) or `settle_upto_channel_unavailable` (`upto`); nothing was submitted, and the Resource Server may retry. A store that cannot be reached returns the same codes at once. Both are local codes, not in the x402 error list. `/verify` and `/health` do not depend on the store.

| Event                                  | Level | Meaning                                                                                                                                                                                              |
| -------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settlement_completed`                 | info  | One per settlement the engine runs: `network`, `scheme`, `channel`, `result` (`settled`, `pending`, `channel_unavailable`, `failed`, `error`), `errorReason`, `errorName`, `txHash`, `acquireWaitMs` |
| `channel_pool_exhausted`               | warn  | A settlement found no free channel within the acquire wait                                                                                                                                           |
| `settlement_channel_store_unavailable` | warn  | A settlement failed because the store did not answer                                                                                                                                                 |
| `channel_store_unavailable`            | warn  | The store connection failed, once per outage, with `errorName` and `errorMessage`                                                                                                                    |
| `channel_store_command_failed`         | warn  | A store command failed: `command` (`seed`, `acquire`, `finish`, `members`, `removeMember`), `errorName`, `errorMessage`, and `channel` for `removeMember`                                            |
| `channel_removed`                      | error | A member whose account is wrong for this deployment left the pool                                                                                                                                    |
| `channel_remove_failed`                | warn  | A wrong account could not be removed (`errorName`); it stays in the pool, is never signed with, and the next pick retries the removal                                                                |
| `channel_signer_load_failed`           | warn  | A member's key could not be loaded this time; it stays and is tried again                                                                                                                            |

**Membership.** On an empty store, the first instance seeds the member set from `FACILITATOR_STELLAR_CHANNEL_SECRETS`; after that the set is the operators', changed with plain commands. Every instance sees a change at its next lease, without a restart. An added channel's secret must already be in `FACILITATOR_STELLAR_CHANNEL_SECRETS` on every instance: an instance that cannot derive a member removes it for all of them.

```bash
ZADD x402:channels NX 0 <address>          # add; tried first
ZREM x402:channels <address>               # remove; a current lease runs to its end
ZRANGE x402:channels 0 -1 WITHSCORES       # list, least recently leased first
EXISTS x402:lease:<address>                # is it leased (or cooling down)
```

Locally, run them through `docker compose exec valkey valkey-cli`. After changing `FACILITATOR_STELLAR_CHANNEL_SECRETS`, run `DEL x402:channels` and restart: seeding fills only an empty set, so new secrets would otherwise never join, while the old members would each be removed. `pnpm testnet:create-account [n]` creates, funds and prints a fee payer, n channels and an `upto` authorization key.

With KMS signing the seed list is `FACILITATOR_KMS_CHANNEL_ADDRESSES`, and an added member needs its `alias/x402/channel/<address>` alias to exist first: a member without one is removed (see [KMS signing](#kms-signing)).

## KMS signing

With `FACILITATOR_SIGNING_MODE=kms`, channel, fee-payer and `upto` authorization signatures are produced by AWS KMS; no private key reaches the process. `env` remains the default for local development, and only there: with `NODE_ENV=production`, which the Docker image sets, `env` mode stops startup, because deployed networks sign with KMS. Docker Compose runs the image locally with `NODE_ENV=development`. Seeds are refused in `kms` mode: startup fails if `FACILITATOR_STELLAR_PRIVATE_KEY`, `FACILITATOR_STELLAR_FEE_BUMP_SECRET` or `FACILITATOR_STELLAR_CHANNEL_SECRETS` is set. A KMS deployment uses new accounts, not the seed-based ones.

**Keys.** Each key is `ECC_NIST_EDWARDS25519` / `SIGN_VERIFY`, reachable by the alias `alias/x402/<channel|fee-payer|facilitator>/<address>` (the G address of its public key; the `upto` authorization key's alias says `facilitator`, the address Buyers authorize), and tagged `Project=facilitator`, `x402:network=<testnet|pubnet>`, `x402:environment=<environment>` (set by `kms:provision`) and `x402:role=<channel|fee-payer|authorization>`. IAM grants are by `x402:network`, `x402:environment` and `x402:role`, so a deployment signs only with its own environment's keys.

**Provisioning** runs on an operator machine, not in the service:

```bash
pnpm kms:provision create --environment devnet --network testnet --role channel [--balance 1.5] [--region us-west-1]
pnpm kms:provision fund --environment devnet --network testnet --role channel --address G... [--balance 1.5] [--yes]
```

`create` makes the key, alias and tags (`--environment` becomes the `x402:environment` tag; lowercase letters, digits and `-`), then funds the account. `fund` is idempotent: it re-checks the alias and that the key's `x402:network`, `x402:environment` and `x402:role` tags match `--network`, `--environment` and `--role`, refuses to fund on any mismatch, and creates the Stellar account only if it does not exist. Funding signs with `PROVISION_FUNDER_SECRET`, read only when funding. On `pubnet`, `create` refuses without `--yes` before making any key, and funding prints funder, destination and amount and refuses without `--yes`. The region is `--region`, then `AWS_REGION`, then `us-west-1`. The operator needs `kms:CreateKey`, `kms:TagResource`, `kms:CreateAlias`, `kms:GetPublicKey` and `kms:ListResourceTags`. After a crash mid-create, find stray keys by the tag `Project=facilitator`.

**Service IAM.** The task role needs `kms:GetPublicKey` and `kms:Sign` on keys tagged for its own network, environment and role. It does not need alias or key-management permissions.

**Startup checks.** The fee payer and authorization addresses are each resolved through the alias of the role it is configured for and the key's public key must derive that address; afterwards the service signs by key ARN, never by alias.

| Role                     | Key mismatch                                   | KMS error                                      | Effect                            |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------- | --------------------------------- |
| Fee payer, authorization | `kms_signer_rejected` (`reason: key_mismatch`) | `kms_signer_unavailable` (`reason: kms_error`) | Fatal: the process does not start |

Channel keys load in the channel pool: every member's in the background after startup, and a member first seen at its first lease. Startup does not wait for them, and a pool with no usable channel answers settlements as pool-full.

| Channel key                        | Event                                                               | Effect                                                               |
| ---------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Mismatch or wrong spec             | `channel_removed` (`reason` says why; treat as a security alert)    | Removed from the pool for every instance                             |
| Alias missing                      | `channel_removed` (`reason: no KMS channel alias for this address`) | Removed from the pool for every instance                             |
| KMS error, `AccessDenied` included | `channel_signer_load_failed` (`errorName`)                          | Skipped this time, kept, and loaded again the next time it is leased |

**Logs.** Every key that loads logs an info `kms_signer_loaded` event with `role` (`fee_payer`, `authorization` or `channel`), `address` and `keyArn`: the address to key ARN audit trail. Two events report runtime signing failures:

| Event                       | Level | Fields                                           | Meaning                                                                           |
| --------------------------- | ----- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `kms_sign_failed`           | warn  | `address`, `keyArn`, `errorName`, `errorMessage` | KMS refused or failed a signature (throttling, access denied, bad signature)      |
| `settlement_signing_failed` | warn  | `channel`, `errorReason`                         | A settlement failed before broadcast on a signing error; its channel was released |

A channel whose key starts failing at runtime stays in the pool and fails about 1 in N settlements (N channels) until the process restarts. Logs carry addresses, key ARNs, aliases and error messages, never key material, payloads, XDR or signatures.

`/health` does not say how keys are held; the startup log line `facilitator_engine_ready` carries `signing` (`env` or `kms`). `/supported` lists only `upto`'s authorization address under `signers`, the same address as its `extra.facilitator`; with `upto` disabled the list is empty. Channel and fee-payer addresses are not advertised.

A Buyer transaction that sets `ledgerBounds`, `minAccountSequence*` or `extraSigners` is rejected by `/verify` and `/settle` before a channel is leased, with the local reason `invalid_exact_stellar_payload_preconditions` or `invalid_upto_stellar_payload_preconditions`: settlement rebuilds the payment on a channel, where those conditions would fail.

**Adding channels on pubnet:** see [Runbook: adding pubnet channels](#runbook-adding-pubnet-channels).

**KMS call bounds.** Each call makes at most 3 attempts, with a 3 s connect timeout and 5 s request and socket timeouts. A startup that fails on a KMS outage can take about 45 to 50 s in the worst case with `upto` (about 30 s without); keep the ECS health-check grace period above that.

## Credential rules

- Stellar secret keys, channel secrets, the fee-bump secret, `DATABASE_URL` and Resource Server API keys are server-side only. Store them in a secret manager or an untracked `.env` file.
- `/supported` returns only public signer addresses. `/verify` may return the public payer address. `/settle` returns the public payer and transaction hash.
- Never return an API key/token/secret after a paid API or MCP call. The paid response is the requested resource plus the `PAYMENT-RESPONSE` settlement receipt. Upstream provider credentials remain inside the resource server.
- Logs intentionally exclude authorization headers, payment payloads, signatures, and private keys.

When `BAZAAR_SETTLEMENT_URL` and `BAZAAR_SETTLEMENT_API_KEY` are configured, a successful
settlement is reported to the Bazaar with its transaction hash, resource URL, network and payer.
The callback is best-effort and idempotent; an unavailable Bazaar never turns an already-settled
payment into a failed payment.

The Bazaar callback is optional. With both variables unset, the Facilitator runs independently and no Bazaar service is contacted.

## Idempotency and scaling

The process coalesces concurrent identical `/settle` calls and caches successful results for five minutes. Only an identical request shares that result. A resend of the same Buyer authorization with another amount, `payTo` or asset gets `settlement_amount_conflict`, on any instance. A resend of an authorization whose transaction was included and failed gets `invalid_transaction_state`; one whose transaction the chain proves can never land gets `settlement_expired` (nothing was charged). The settlement row recorded before the transaction is signed makes sure only one of them is ever broadcast. `/settle` with `amount: "0"` verifies the authorization like any other amount, sends nothing and answers `{ "success": true, "transaction": "", "amount": "0", "payer": … }`, as upstream EVM `upto` does. For `upto` it first records the authorization as settled for zero, so a later settle of it for another amount gets `settlement_amount_conflict`; if that record cannot be written the settle fails with HTTP 500. A zero `exact` payment, which the upstream Buyer client never creates, is answered the same way without a record.

This is not durable across a restart. Before `upto` can be advertised as production-conformant, replace the cache with a durable settlement journal keyed by the signed authorization and retained through its deadline. The journal must preserve confirmed non-zero receipts and submission-pending state; Stellar's nonce prevents a second transfer but cannot recover the original response after the in-memory entry expires.

## Runbook: adding pubnet channels

For operators. It creates channel keys in KMS, opens and funds their pubnet accounts, then adds them
to the channel store. The script never touches the store; the last step is manual. Run steps 1–3 on
an operator machine with your own AWS credentials, and step 4 from inside the VPC.

**Before you start**

- AWS credentials for the facilitator's account with `kms:CreateKey`, `kms:TagResource`,
  `kms:CreateAlias`, `kms:GetPublicKey` and `kms:ListResourceTags`. The region defaults to
  `us-west-1`.
- The pubnet deployment's environment name, used as `--environment` below. It becomes the key's
  `x402:environment` tag, and the deployment's task role may only sign with keys tagged with its
  own environment and `x402:network=pubnet`.
- A funder account on pubnet: its `S…` secret, holding at least 1.5 XLM per channel plus fees
  (about 0.0001 XLM per account).

**1. Load the funder secret without echo or shell history**

```bash
cd packages/facilitator
read -rs PROVISION_FUNDER_SECRET && export PROVISION_FUNDER_SECRET
```

Never put the secret on the command line or in a file. Step 5 removes it from the shell.

**2. Create and fund the channels**, one key per run:

```bash
for i in $(seq 1 5); do
  pnpm kms:provision create --environment <environment> --network pubnet --role channel --yes
done
```

Each run:

- creates a KMS key with the alias `alias/x402/channel/<address>`;
- tags it `x402:network=pubnet`, `x402:environment=<environment>` and `x402:role=channel`;
- opens the account from the funder with 1.5 XLM (`--balance` changes it);
- prints the new `G…` address last. Collect those addresses.

Without `--yes`, a pubnet run stops before creating anything.

If a run fails after its key exists, it prints the key ARN and a `fund` command. Run that command:
it re-checks the key and funds the account only if it does not exist yet. A key whose alias
creation failed is reported with the commands to find and delete it.

**3. Check every address before adding it**

```bash
pnpm kms:provision fund --environment <environment> --network pubnet --role channel --address G... --yes
```

The check fails unless:

- the alias resolves to a key that derives this address;
- the key's `x402:network`, `x402:environment` and `x402:role` tags match the flags.

An existing account is reported as `already exists; not funded again`, which is the expected result
here. **Do not add an address that fails this check:**

- an alias problem makes every instance remove it from the pool on load (`channel_removed`);
- a tag problem leaves it in the pool but unusable, with `channel_signer_load_failed` on every lease.

**4. Add the channels to the store**, from inside the VPC, against the store the pubnet deployment
uses (its `CHANNEL_STORE_URL`, with TLS and AUTH):

```bash
valkey-cli --tls -h <store host> -p 6379 -a '<auth token>' -n <db>
ZADD x402:channels NX 0 G... 0 G... 0 G...
ZRANGE x402:channels 0 -1 WITHSCORES
```

The store holds:

| Key                    | Type       | Contents                                                                                  | Written by                                                   |
| ---------------------- | ---------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `x402:channels`        | sorted set | member: a channel's `G…` address; score: when it was last leased (ms). `0` is tried first | operators add and remove members; the service updates scores |
| `x402:lease:<address>` | string     | the token of the settlement holding the channel, expiring with the lease or cooldown      | the service only                                             |

`NX` leaves an existing member's score alone. No restart is needed: every instance uses a new member
at its next lease. `FACILITATOR_KMS_CHANNEL_ADDRESSES` only seeds an empty set, so it does not need
the new addresses.

Never run `DEL x402:channels` or `FLUSHDB`, and never touch `x402:lease:*`: removing a lease frees a
channel whose transaction may still land, and the next settlement on it fails with a sequence
conflict. To retire a channel, use `ZREM x402:channels <address>`; a current lease runs to its end.

**5. Confirm, then clear the secret**

In the service logs, each new address should log `kms_signer_loaded` with `role: channel` once it
loads. None should log `channel_removed` or `channel_signer_load_failed`.

```bash
unset PROVISION_FUNDER_SECRET
```
