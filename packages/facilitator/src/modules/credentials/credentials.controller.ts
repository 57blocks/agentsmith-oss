import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AttributedRequest } from './caller.js';
import { RegisterRequestDto } from './dto/credentials-request.dto.js';
import { RegistrationValidationPipe } from './dto/credentials-validation.pipe.js';
import { CallerGuard } from './guards/caller.guard.js';
import { RegisterRateLimitGuard } from './guards/register-rate-limit.guard.js';
import {
  CredentialsService,
  DomainTakenError,
  NotCurrentKeyError,
  type KeyHolder,
} from './services/credentials.service.js';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorBodyDto } from '../../common/dto/error-body.dto.js';
import { RegisterResponseDto, RotateResponseDto } from './dto/credentials-response.dto.js';

function failure(status: number, code: string, message: string): HttpException {
  return new HttpException({ error: { code, message } }, status);
}

/** The key the request presented; an anonymous testnet caller has none and is refused. */
function keyHolder({ caller }: AttributedRequest): KeyHolder {
  if (!caller.credentialId) throw failure(401, 'UNAUTHORIZED', 'Bearer token required');
  return { resourceServerId: caller.resourceServerId, credentialId: caller.credentialId };
}

/** Self-service routes for Resource Servers; a local extension, not part of x402. */
@ApiTags('credentials')
@Controller('credentials')
export class CredentialsController {
  constructor(@Inject(CredentialsService) private readonly credentials: CredentialsService) {}

  @ApiCreatedResponse({ type: RegisterResponseDto })
  @ApiBadRequestResponse({ type: ErrorBodyDto, description: 'INVALID_REQUEST' })
  @ApiConflictResponse({ type: ErrorBodyDto, description: 'DOMAIN_TAKEN' })
  @ApiTooManyRequestsResponse({ type: ErrorBodyDto, description: 'Registration limit per IP' })
  @Post('register')
  @ApiBody({ type: RegisterRequestDto })
  @UseGuards(RegisterRateLimitGuard)
  async register(
    @Body(new RegistrationValidationPipe()) request: RegisterRequestDto,
    @Req() http: Request,
  ): Promise<{ resourceServerId: string; apiKey: string }> {
    try {
      return await this.credentials.register(request, http.ip);
    } catch (error) {
      if (!(error instanceof DomainTakenError)) throw error;
      throw failure(409, 'DOMAIN_TAKEN', 'This domain is already registered');
    }
  }

  @ApiBearerAuth()
  @ApiCreatedResponse({
    type: RotateResponseDto,
    description: 'The old key keeps working for ten minutes',
  })
  @ApiUnauthorizedResponse({ type: ErrorBodyDto })
  @ApiConflictResponse({ type: ErrorBodyDto, description: 'NOT_CURRENT_KEY' })
  @ApiTooManyRequestsResponse({ type: ErrorBodyDto })
  @ApiServiceUnavailableResponse({ type: ErrorBodyDto })
  @Post('keys/rotate')
  @UseGuards(CallerGuard)
  async rotate(@Req() request: AttributedRequest): Promise<{ apiKey: string }> {
    try {
      return await this.credentials.rotate(keyHolder(request));
    } catch (error) {
      if (!(error instanceof NotCurrentKeyError)) throw error;
      throw failure(409, 'NOT_CURRENT_KEY', 'Only the current key can rotate');
    }
  }

  @ApiBearerAuth()
  @ApiNoContentResponse({ description: 'The presented key is revoked' })
  @ApiUnauthorizedResponse({ type: ErrorBodyDto })
  @ApiTooManyRequestsResponse({ type: ErrorBodyDto })
  @ApiServiceUnavailableResponse({ type: ErrorBodyDto })
  @Delete('keys/current')
  @HttpCode(204)
  @UseGuards(CallerGuard)
  async revokeCurrent(@Req() request: AttributedRequest): Promise<void> {
    await this.credentials.revokeCurrent(keyHolder(request));
  }
}
