import { ApiProperty } from '@nestjs/swagger';

export class ErrorDetailDto {
  @ApiProperty({ type: String, example: 'UNAUTHORIZED' })
  code!: string;

  @ApiProperty({ type: String, example: 'Bearer token required' })
  message!: string;
}

/** The body of every non-x402 error: guards, rate limits, credentials and the error filter. */
export class ErrorBodyDto {
  @ApiProperty({ type: () => ErrorDetailDto })
  error!: ErrorDetailDto;
}
