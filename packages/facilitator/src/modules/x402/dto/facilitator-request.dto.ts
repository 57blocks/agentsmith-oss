import { ApiProperty, ApiPropertyOptional, type ApiPropertyOptions } from '@nestjs/swagger';
import { Exclude, Expose, Type } from 'class-transformer';
import {
  Equals,
  IsDefined,
  IsInt,
  IsObject,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** An x402 object this Facilitator passes through; the x402 v2 specification defines it. */
const OPEN_OBJECT: ApiPropertyOptions = {
  type: Object,
  additionalProperties: true,
  description: 'Defined by the x402 v2 specification',
};

export class PaymentRequirementsDto {
  @ApiProperty({ type: String, minLength: 1, example: 'exact' })
  @IsString()
  @MinLength(1)
  scheme!: string;

  @ApiProperty({ type: String, pattern: '^[a-z0-9-]+:[A-Za-z0-9-]+$', example: 'stellar:testnet' })
  @Matches(/^[a-z0-9-]+:[A-Za-z0-9-]+$/)
  network!: string;

  @ApiProperty({ type: String, pattern: '^[0-9]+$', description: 'Atomic units' })
  @Matches(/^[0-9]+$/)
  amount!: string;

  @ApiProperty({ type: String, minLength: 1 })
  @IsString()
  @MinLength(1)
  asset!: string;

  @ApiProperty({ type: String, minLength: 1 })
  @IsString()
  @MinLength(1)
  payTo!: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 300 })
  @IsInt()
  @Min(1)
  @Max(300)
  maxTimeoutSeconds!: number;

  @ApiPropertyOptional(OPEN_OBJECT)
  @IsObject()
  extra: Record<string, unknown> = {};
}

export class PaymentPayloadDto {
  @ApiProperty({ type: 'integer', enum: [2] })
  @Equals(2)
  x402Version!: 2;

  @ApiProperty({ type: () => PaymentRequirementsDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => PaymentRequirementsDto)
  accepted!: PaymentRequirementsDto;

  @ApiProperty(OPEN_OBJECT)
  @IsObject()
  payload!: Record<string, unknown>;

  @ApiPropertyOptional(OPEN_OBJECT)
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsObject()
  resource?: Record<string, unknown>;

  @ApiPropertyOptional(OPEN_OBJECT)
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsObject()
  extensions?: Record<string, unknown>;
}

@Exclude()
export class FacilitatorRequestDto {
  @ApiProperty({ type: 'integer', enum: [2] })
  @Expose()
  @Equals(2)
  x402Version!: 2;

  @ApiProperty({ type: () => PaymentPayloadDto })
  @Expose()
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => PaymentPayloadDto)
  paymentPayload!: PaymentPayloadDto;

  @ApiProperty({ type: () => PaymentRequirementsDto })
  @Expose()
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => PaymentRequirementsDto)
  paymentRequirements!: PaymentRequirementsDto;
}
