import { HttpException, ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { AdminIdParamsDto } from './admin-id-params.dto.js';
import { RegisterRequestDto } from './credentials-request.dto.js';

/** The first failing field and rule, e.g. `domain: must be a bare host name`; never its value. */
function firstFailure(errors: ValidationError[]): string {
  const error = errors[0];
  const rule = Object.values(error?.constraints ?? {})[0];
  if (!error || !rule || error.constraints?.unknownValue) return 'body: must be an object';
  return `${error.property}: ${rule}`;
}

// Vitest's esbuild transform and tsx emit no parameter metadata, so each pipe names its DTO.
const options = {
  transform: true,
  transformOptions: { enableImplicitConversion: false },
  whitelist: true,
  forbidNonWhitelisted: false,
  validationError: { target: false, value: false },
};

/** Registration bodies: 400 `INVALID_REQUEST` naming the field. */
export class RegistrationValidationPipe extends ValidationPipe {
  constructor() {
    super({
      ...options,
      expectedType: RegisterRequestDto,
      exceptionFactory: (errors: ValidationError[]) =>
        new HttpException(
          { error: { code: 'INVALID_REQUEST', message: firstFailure(errors) } },
          400,
        ),
    });
  }
}

/** Admin path ids: an id that is not a UUID cannot exist, so 404, and it never reaches SQL. */
export class AdminIdValidationPipe extends ValidationPipe {
  constructor() {
    super({
      ...options,
      expectedType: AdminIdParamsDto,
      exceptionFactory: () =>
        new HttpException({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404),
    });
  }
}
