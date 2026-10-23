import { HttpException, ValidationPipe } from '@nestjs/common';
import type { SettleResponse, VerifyResponse } from '@x402/core/types';
import type { ValidationError } from 'class-validator';
import { FacilitatorRequestDto } from './facilitator-request.dto.js';

interface RequestRejection {
  reason: 'invalid_x402_version' | 'invalid_payment_requirements' | 'invalid_payload';
  message: string;
}

function requestRejection(errors: ValidationError[], parent: string[] = []): RequestRejection {
  const error = errors[0];
  const path = error ? [...parent, error.property] : parent;
  if (!error?.constraints && error?.children?.length) {
    return requestRejection(error.children, path);
  }
  const reason =
    path.at(-1) === 'x402Version'
      ? 'invalid_x402_version'
      : path[0] === 'paymentRequirements'
        ? 'invalid_payment_requirements'
        : 'invalid_payload';
  const message = Object.values(error?.constraints ?? {})[0] ?? 'invalid request';
  return { reason, message: `${path.join('.') || 'body'}: ${message}` };
}

function requestedNetwork(body: unknown): string {
  if (!body || typeof body !== 'object' || !('paymentRequirements' in body)) return '';
  const requirements = body.paymentRequirements;
  if (!requirements || typeof requirements !== 'object' || !('network' in requirements)) return '';
  return typeof requirements.network === 'string' ? requirements.network : '';
}

/** Validates before the controller runs while keeping x402's route-specific error bodies. */
export class FacilitatorValidationPipe extends ValidationPipe {
  constructor(operation: 'verify' | 'settle') {
    super({
      // Vitest's esbuild transform does not emit parameter type metadata.
      expectedType: FacilitatorRequestDto,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      whitelist: false,
      validationError: { target: true, value: false },
      exceptionFactory: (errors: ValidationError[]) => {
        const { reason, message } = requestRejection(errors);
        const response =
          operation === 'verify'
            ? ({
                isValid: false,
                invalidReason: reason,
                invalidMessage: message,
              } satisfies VerifyResponse)
            : ({
                success: false,
                errorReason: reason,
                errorMessage: message,
                transaction: '',
                network: requestedNetwork(errors[0]?.target),
              } satisfies Omit<SettleResponse, 'network'> & { network: string });
        return new HttpException(response, 400);
      },
    });
  }
}
