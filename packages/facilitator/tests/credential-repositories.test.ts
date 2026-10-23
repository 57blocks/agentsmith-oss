import { SHARED_KEY_RESOURCE_SERVER_ID } from '../src/models/credentials/resource-server.model.js';
import { createHash, randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateToLatest } from '../src/common/database/migrate.js';
import type { Database } from '../src/models/database.js';
import { ApiCredentialRepository } from '../src/modules/credentials/repositories/api-credential.repository.js';
import { RegistrationSourceRepository } from '../src/modules/credentials/repositories/registration-source.repository.js';
import { ResourceServerRepository } from '../src/modules/credentials/repositories/resource-server.repository.js';
import { createTestDatabase } from './test-database.js';

let db: Kysely<Database>;
let servers: ResourceServerRepository;
let credentials: ApiCredentialRepository;

beforeEach(async () => {
  db = await createTestDatabase();
  servers = new ResourceServerRepository(db);
  credentials = new ApiCredentialRepository(db);
});

afterEach(async () => {
  await db.destroy();
});

const digest = (key = randomBytes(32).toString('base64url')) =>
  createHash('sha256').update(key).digest();

function newServer(domain = 'weather.example.com') {
  return servers.create({ name: 'Weather API', domain });
}

/**
 * Moves a key's creation a second into the past. PGlite's `now()` has millisecond resolution, so
 * two keys issued back to back can share `created_at`, and "newest" would be a coin toss.
 */
async function issuedEarlier(id: string): Promise<void> {
  await sql`update api_credentials set created_at = created_at - interval '1 second'
    where id = ${id}`.execute(db);
}

describe('database migrations', () => {
  it('apply nothing the second time', async () => {
    expect(await migrateToLatest(db)).toEqual([]);
  });
});

describe('ResourceServerRepository', () => {
  it('creates an active server', async () => {
    const server = await newServer();
    expect(server.status).toBe('active');
    expect(server.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the contact email given at registration, which several servers may share', async () => {
    const email = 'dev@weather.example.com';
    const first = await servers.create({ name: 'Weather API', domain: 'a.example.com', email });
    const second = await servers.create({ name: 'Tide API', domain: 'b.example.com', email });

    expect([first.email, second.email]).toEqual([email, email]);
  });

  it('leaves the email empty on the shared-key server, which predates registration', async () => {
    const [shared] = await servers.list();
    expect(shared).toMatchObject({ id: SHARED_KEY_RESOURCE_SERVER_ID, email: null });
  });

  it('rejects a second server with the same domain', async () => {
    await newServer();
    await expect(newServer()).rejects.toThrow();
  });

  it('changes the status, and reports an unknown id as undefined', async () => {
    const server = await newServer();
    expect((await servers.setStatus(server.id, 'disabled'))?.status).toBe('disabled');
    expect(
      await servers.setStatus('00000000-0000-0000-0000-000000000000', 'active'),
    ).toBeUndefined();
  });
});

describe('ApiCredentialRepository', () => {
  it('finds an active key by its digest and attributes it to its server', async () => {
    const server = await newServer();
    const secretDigest = digest();
    const issued = await credentials.issue({ resourceServerId: server.id, secretDigest });

    expect(await credentials.findActiveBySecretDigest(secretDigest)).toEqual({
      credentialId: issued.id,
      resourceServerId: server.id,
    });
    expect(await credentials.findActiveBySecretDigest(digest())).toBeUndefined();
  });

  it('rejects a duplicate digest and a digest that is not 32 bytes', async () => {
    const server = await newServer();
    const secretDigest = digest();
    await credentials.issue({ resourceServerId: server.id, secretDigest });
    await expect(
      credentials.issue({ resourceServerId: server.id, secretDigest }),
    ).rejects.toThrow();
    await expect(
      credentials.issue({ resourceServerId: server.id, secretDigest: randomBytes(31) }),
    ).rejects.toThrow();
  });

  it('stops finding an expired key, but keeps one that expires later', async () => {
    const server = await newServer();
    const expired = digest();
    const later = digest();
    await credentials.issue({
      resourceServerId: server.id,
      secretDigest: expired,
      expiresAt: new Date(Date.now() - 1_000),
    });
    await credentials.issue({
      resourceServerId: server.id,
      secretDigest: later,
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(await credentials.findActiveBySecretDigest(expired)).toBeUndefined();
    expect(await credentials.findActiveBySecretDigest(later)).toBeDefined();
  });

  it('stops finding a revoked key while the server keeps its other keys', async () => {
    const server = await newServer();
    const oldDigest = digest();
    const newDigest = digest();
    const oldKey = await credentials.issue({
      resourceServerId: server.id,
      secretDigest: oldDigest,
    });
    await credentials.issue({ resourceServerId: server.id, secretDigest: newDigest });

    expect(await credentials.revoke(oldKey.id)).toBe(true);
    expect(await credentials.findActiveBySecretDigest(oldDigest)).toBeUndefined();
    expect(await credentials.findActiveBySecretDigest(newDigest)).toBeDefined();

    const revoked = (await credentials.listByResourceServer(server.id)).find(
      (credential) => credential.id === oldKey.id,
    );
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
  });

  it('takes the newest key as current, even one issued with an expiry', async () => {
    const server = await newServer();
    const older = await credentials.issue({ resourceServerId: server.id, secretDigest: digest() });
    await issuedEarlier(older.id);
    const newest = await credentials.issue({
      resourceServerId: server.id,
      secretDigest: digest(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect((await credentials.findCurrent(server.id))?.id).toBe(newest.id);
  });

  it('has no current key once the newest is revoked, though an older one still works', async () => {
    const server = await newServer();
    const replacedDigest = digest();
    const replaced = await credentials.issue({
      resourceServerId: server.id,
      secretDigest: replacedDigest,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await issuedEarlier(replaced.id);
    const replacement = await credentials.issue({
      resourceServerId: server.id,
      secretDigest: digest(),
    });

    await credentials.revoke(replacement.id);

    expect(await credentials.findCurrent(server.id)).toBeUndefined();
    expect(await credentials.findActiveBySecretDigest(replacedDigest)).toBeDefined();
  });

  it('has no current key once the newest has expired', async () => {
    const server = await newServer();
    const older = await credentials.issue({ resourceServerId: server.id, secretDigest: digest() });
    await issuedEarlier(older.id);
    await credentials.issue({
      resourceServerId: server.id,
      secretDigest: digest(),
      expiresAt: new Date(Date.now() - 1_000),
    });

    expect(await credentials.findCurrent(server.id)).toBeUndefined();
  });

  it('keeps an expiry sooner than the grace period it is given', async () => {
    const server = await newServer();
    const soon = new Date(Date.now() + 60_000);
    const key = await credentials.issue({
      resourceServerId: server.id,
      secretDigest: digest(),
      expiresAt: soon,
    });

    expect(await credentials.expireWithin(key.id, 10 * 60_000)).toBe(true);

    const [stored] = await credentials.listByResourceServer(server.id);
    expect(stored?.expiresAt?.getTime()).toBe(soon.getTime());
  });

  it('gives a revoked key no grace period', async () => {
    const server = await newServer();
    const key = await credentials.issue({ resourceServerId: server.id, secretDigest: digest() });
    await credentials.revoke(key.id);

    expect(await credentials.expireWithin(key.id, 10 * 60_000)).toBe(false);

    const [stored] = await credentials.listByResourceServer(server.id);
    expect(stored?.expiresAt).toBeNull();
  });

  it('treats a revocation as final', async () => {
    const server = await newServer();
    const key = await credentials.issue({ resourceServerId: server.id, secretDigest: digest() });
    expect(await credentials.revoke(key.id)).toBe(true);
    expect(await credentials.revoke(key.id)).toBe(false);
  });

  it('hides every key of a disabled server until it is enabled again', async () => {
    const server = await newServer();
    const secretDigest = digest();
    await credentials.issue({ resourceServerId: server.id, secretDigest });

    await servers.setStatus(server.id, 'disabled');
    expect(await credentials.findActiveBySecretDigest(secretDigest)).toBeUndefined();

    await servers.setStatus(server.id, 'active');
    expect(await credentials.findActiveBySecretDigest(secretDigest)).toBeDefined();
  });
});

describe('RegistrationSourceRepository', () => {
  const HOUR_MS = 3_600_000;

  /** A registration from `source` made `hoursAgo` hours ago, by the database clock. */
  async function registeredAgo(source: Buffer, hoursAgo: number): Promise<void> {
    await sql`insert into registration_source (ip_digest, created_at)
      values (${source}, now() - ${hoursAgo} * interval '1 hour')`.execute(db);
  }

  it('counts the registrations of one source within the window only', async () => {
    const sources = new RegistrationSourceRepository(db);
    const [source, other] = [digest(), digest()];
    await registeredAgo(source, 0.5);
    await sources.record(source, HOUR_MS);
    await sources.record(other, HOUR_MS);

    expect(await sources.countWithin(source, HOUR_MS)).toBe(2);
    expect(await sources.countWithin(source, HOUR_MS / 4)).toBe(1);
    expect(await sources.countWithin(other, HOUR_MS)).toBe(1);
  });

  it('drops every source older than the window when it records one', async () => {
    const sources = new RegistrationSourceRepository(db);
    const [stale, recent, fresh] = [digest(), digest(), digest()];
    await registeredAgo(stale, 2);
    await registeredAgo(recent, 0.5);

    await sources.record(fresh, HOUR_MS);

    const kept = await db.selectFrom('registrationSource').select('ipDigest').execute();
    const hex = (digests: Uint8Array[]) =>
      digests.map((d) => Buffer.from(d).toString('hex')).sort();
    expect(hex(kept.map((row) => row.ipDigest))).toEqual(hex([recent, fresh]));
  });

  it('rejects a digest that is not 32 bytes', async () => {
    await expect(
      new RegistrationSourceRepository(db).record(Buffer.alloc(16), HOUR_MS),
    ).rejects.toThrow();
  });
});
