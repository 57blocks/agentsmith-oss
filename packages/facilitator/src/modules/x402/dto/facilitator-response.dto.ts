import { ApiProperty, ApiPropertyOptional, type ApiPropertyOptions } from '@nestjs/swagger';

// Documentation only: the controller returns the x402 types, which these mirror.
const OPEN_OBJECT: ApiPropertyOptions = {
  type: Object,
  additionalProperties: true,
  description: 'Defined by the x402 v2 specification',
};

export class HealthResponseDto {
  @ApiProperty({ type: Boolean, example: true })
  ok!: boolean;

  @ApiProperty({ type: String, example: 'agentsmith-stellar-facilitator' })
  service!: string;

  @ApiProperty({ type: String, example: '0.1.0' })
  version!: string;

  @ApiProperty({ type: String, example: 'stellar:testnet' })
  network!: string;
}

export class SupportedKindDto {
  @ApiProperty({ type: 'integer', example: 2 })
  x402Version!: number;

  @ApiProperty({ type: String, example: 'exact' })
  scheme!: string;

  @ApiProperty({ type: String, example: 'stellar:testnet' })
  network!: string;

  @ApiPropertyOptional(OPEN_OBJECT)
  extra?: Record<string, unknown>;
}

export class SupportedResponseDto {
  @ApiProperty({ type: () => SupportedKindDto, isArray: true })
  kinds!: SupportedKindDto[];

  @ApiProperty({ type: String, isArray: true })
  extensions!: string[];

  @ApiProperty({
    type: Object,
    additionalProperties: { type: 'array', items: { type: 'string' } },
    description: 'CAIP-2 network pattern → signer addresses',
  })
  signers!: Record<string, string[]>;
}

export class VerifyResponseDto {
  @ApiProperty({ type: Boolean })
  isValid!: boolean;

  @ApiPropertyOptional({ type: String, example: 'invalid_payload' })
  invalidReason?: string;

  @ApiPropertyOptional({ type: String })
  invalidMessage?: string;

  @ApiPropertyOptional({ type: String, description: 'Buyer address' })
  payer?: string;
}

export class SettleResponseDto {
  @ApiProperty({ type: Boolean })
  success!: boolean;

  @ApiPropertyOptional({ type: String, example: 'settlement_pending' })
  errorReason?: string;

  @ApiPropertyOptional({ type: String })
  errorMessage?: string;

  @ApiPropertyOptional({ type: String, description: 'Buyer address' })
  payer?: string;

  @ApiProperty({ type: String, description: 'Transaction hash; empty when nothing was sent' })
  transaction!: string;

  @ApiProperty({ type: String, example: 'stellar:testnet' })
  network!: string;

  @ApiPropertyOptional({ type: String, description: 'Settled amount in atomic units' })
  amount?: string;
}
