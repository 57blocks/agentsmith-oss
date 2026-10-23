import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RegisterRequestDto } from '../src/modules/credentials/dto/credentials-request.dto.js';
import {
  AdminIdValidationPipe,
  RegistrationValidationPipe,
} from '../src/modules/credentials/dto/credentials-validation.pipe.js';

// No `metatype`: the esbuild test transform emits no parameter metadata, as in production dev.
const body = { type: 'body' as const };
const param = { type: 'param' as const };

async function rejection(run: () => Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpException)
      return { status: error.getStatus(), body: error.getResponse() };
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('RegistrationValidationPipe', () => {
  const pipe = new RegistrationValidationPipe();

  it('returns a normalised RegisterRequestDto without its unknown fields', async () => {
    const parsed = await pipe.transform(
      { name: ' Weather ', domain: ' Weather.Example.COM. ', email: ' Dev@x.io ', role: 'admin' },
      body,
    );

    expect(parsed).toBeInstanceOf(RegisterRequestDto);
    expect({ ...parsed }).toEqual({
      name: 'Weather',
      domain: 'weather.example.com',
      email: 'Dev@x.io',
    });
  });

  it('names the failing field without echoing its value', async () => {
    const refused = await rejection(() =>
      pipe.transform({ name: 'n', domain: 'https://secret.example.com/x', email: 'a@b.io' }, body),
    );

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: { code: 'INVALID_REQUEST', message: expect.stringContaining('domain') },
    });
    expect(JSON.stringify(refused.body)).not.toContain('secret');
  });

  it('does not convert a number into a string', async () => {
    const refused = await rejection(() =>
      pipe.transform({ name: 7, domain: 'a.example.com', email: 'a@b.io' }, body),
    );
    expect(refused.status).toBe(400);
  });

  it('refuses a missing body with the same 400', async () => {
    expect((await rejection(() => pipe.transform(undefined, body))).status).toBe(400);
  });
});

describe('AdminIdValidationPipe', () => {
  const pipe = new AdminIdValidationPipe();

  it.each(['00000000-0000-0000-0000-00000000ABCD', '00000000-0000-0000-0000-000000000000'])(
    'accepts %s as is',
    async (id) => {
      expect((await pipe.transform({ id }, param)).id).toBe(id);
    },
  );

  it.each(['nope', ' 00000000-0000-0000-0000-00000000abcd', '00000000-0000-0000-0000-00000000abc'])(
    'answers %j with 404',
    async (id) => {
      expect((await rejection(() => pipe.transform({ id }, param))).status).toBe(404);
    },
  );
});
