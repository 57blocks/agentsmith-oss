import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../../common/tokens.js';
import type { Database } from '../../../models/database.js';

/** Registration sources, counted when the channel store holding the rate limits is down. */
@Injectable()
export class RegistrationSourceRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  /** Records one registration and drops every source older than the window. */
  async record(ipDigest: Buffer, windowMs: number): Promise<void> {
    await this.db.insertInto('registrationSource').values({ ipDigest }).execute();
    await this.db
      .deleteFrom('registrationSource')
      .where('createdAt', '<', sql<Date>`now() - ${windowMs} * interval '1 millisecond'`)
      .execute();
  }

  /** Registrations from this source within the last `windowMs`, by the database clock. */
  async countWithin(ipDigest: Buffer, windowMs: number): Promise<number> {
    const { count } = await this.db
      .selectFrom('registrationSource')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('ipDigest', '=', ipDigest)
      .where('createdAt', '>=', sql<Date>`now() - ${windowMs} * interval '1 millisecond'`)
      .executeTakeFirstOrThrow();
    return Number(count);
  }
}
