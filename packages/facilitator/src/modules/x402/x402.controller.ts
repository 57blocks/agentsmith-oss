import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { SettleResponse, VerifyResponse } from '@x402/core/types';
import type { AttributedRequest } from '../credentials/caller.js';
import { CallerGuard } from '../credentials/guards/caller.guard.js';
import type { Logger } from '../../common/logger.js';
import { CONFIG, LOG } from '../../common/tokens.js';
import type { FacilitatorConfig } from '../../config/facilitator.config.js';
import { FacilitatorRequestDto } from './dto/facilitator-request.dto.js';
import { FacilitatorValidationPipe } from './dto/facilitator-validation.pipe.js';
import { X402Service } from './services/x402.service.js';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorBodyDto } from '../../common/dto/error-body.dto.js';
import { SERVICE_VERSION } from '../../common/version.js';
import {
  HealthResponseDto,
  SettleResponseDto,
  SupportedResponseDto,
  VerifyResponseDto,
} from './dto/facilitator-response.dto.js';

const HTTP_INTERNAL_ERROR = 500;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

@ApiTags('x402')
@Controller()
export class X402Controller {
  constructor(
    @Inject(CONFIG) private readonly config: FacilitatorConfig,
    @Inject(LOG) private readonly log: Logger,
    @Inject(X402Service) private readonly facilitator: X402Service,
  ) {}

  @ApiOkResponse({ type: HealthResponseDto })
  @Get('health')
  health() {
    return {
      ok: true,
      service: 'agentsmith-stellar-facilitator',
      version: SERVICE_VERSION,
      network: this.config.network,
    };
  }

  @ApiOkResponse({ type: SupportedResponseDto })
  @ApiBearerAuth()
  @ApiUnauthorizedResponse({
    type: ErrorBodyDto,
    description: 'Missing (pubnet), unknown, expired or revoked key',
  })
  @ApiTooManyRequestsResponse({ type: ErrorBodyDto })
  @ApiServiceUnavailableResponse({
    type: ErrorBodyDto,
    description: 'Credentials cannot be checked',
  })
  @Get('supported')
  @UseGuards(CallerGuard)
  supported() {
    return this.facilitator.supported();
  }

  @ApiOkResponse({ type: VerifyResponseDto })
  @ApiBadRequestResponse({ type: VerifyResponseDto, description: 'Malformed x402 request' })
  @ApiBearerAuth()
  @ApiUnauthorizedResponse({
    type: ErrorBodyDto,
    description: 'Missing (pubnet), unknown, expired or revoked key',
  })
  @ApiTooManyRequestsResponse({ type: ErrorBodyDto })
  @ApiServiceUnavailableResponse({
    type: ErrorBodyDto,
    description: 'Credentials cannot be checked',
  })
  @Post('verify')
  @ApiBody({ type: FacilitatorRequestDto })
  @HttpCode(200)
  @UseGuards(CallerGuard)
  async verify(
    @Body(new FacilitatorValidationPipe('verify')) request: FacilitatorRequestDto,
  ): Promise<VerifyResponse> {
    try {
      return await this.facilitator.verify(request);
    } catch (error) {
      this.log.error('verify_unhandled_error', { errorName: errorName(error) });
      throw new HttpException(
        { isValid: false, invalidReason: 'unexpected_verify_error' } satisfies VerifyResponse,
        HTTP_INTERNAL_ERROR,
      );
    }
  }

  @ApiOkResponse({ type: SettleResponseDto })
  @ApiBadRequestResponse({ type: SettleResponseDto, description: 'Malformed x402 request' })
  @ApiInternalServerErrorResponse({
    type: SettleResponseDto,
    description: 'unexpected_settle_error',
  })
  @ApiBearerAuth()
  @ApiUnauthorizedResponse({
    type: ErrorBodyDto,
    description: 'Missing (pubnet), unknown, expired or revoked key',
  })
  @ApiTooManyRequestsResponse({ type: ErrorBodyDto })
  @ApiServiceUnavailableResponse({
    type: ErrorBodyDto,
    description: 'Credentials cannot be checked',
  })
  @Post('settle')
  @ApiBody({ type: FacilitatorRequestDto })
  @HttpCode(200)
  @UseGuards(CallerGuard)
  async settle(
    @Body(new FacilitatorValidationPipe('settle')) request: FacilitatorRequestDto,
    @Req() http: AttributedRequest,
  ): Promise<SettleResponse> {
    try {
      return await this.facilitator.settle(request, http.caller);
    } catch (error) {
      this.log.error('settle_unhandled_error', { errorName: errorName(error) });
      throw new HttpException(
        {
          success: false,
          errorReason: 'unexpected_settle_error',
          transaction: '',
          network: request.paymentRequirements.network as SettleResponse['network'],
        } satisfies SettleResponse,
        HTTP_INTERNAL_ERROR,
      );
    }
  }
}
