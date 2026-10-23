import { ApiProperty } from '@nestjs/swagger';

const API_KEY = {
  type: String,
  description: 'Returned once; only its digest is stored',
  example: 'fsk_…',
};

export class RegisterResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  resourceServerId!: string;

  @ApiProperty(API_KEY)
  apiKey!: string;
}

export class RotateResponseDto {
  @ApiProperty(API_KEY)
  apiKey!: string;
}
