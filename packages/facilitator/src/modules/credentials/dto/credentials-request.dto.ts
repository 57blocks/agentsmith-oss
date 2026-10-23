import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, ValidateBy } from 'class-validator';

/** A bare DNS host name with an alphabetic top-level label; an IP address has none. */
const HOST_NAME = /^(?=.{1,253}$)(?:(?!-)[a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

/** The address pattern registration has always accepted (Zod 3's `emailRegex`). */
const EMAIL = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;

/** Transforms touch strings only, so a number or object is rejected rather than converted. */
const ifString =
  (change: (value: string) => string) =>
  ({ value }: { value: unknown }) =>
    typeof value === 'string' ? change(value) : value;

/**
 * Length in UTF-16 code units, as `string.length` counts. class-validator's length decorators
 * count an emoji as one character instead.
 */
function Utf16Length(min: number, max: number) {
  return ValidateBy({
    name: 'utf16Length',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && value.length >= min && value.length <= max,
      defaultMessage: () => `must be ${min} to ${max} characters`,
    },
  });
}

/** `POST /credentials/register`. */
export class RegisterRequestDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 100, example: 'Weather API' })
  @Transform(ifString((name) => name.trim()))
  @IsString()
  @Utf16Length(1, 100)
  name!: string;

  @ApiProperty({
    type: String,
    description: 'Bare host name; stored lower-case',
    example: 'weather.example.com',
  })
  @Transform(ifString((domain) => domain.trim().toLowerCase().replace(/\.$/, '')))
  @IsString()
  @Matches(HOST_NAME, { message: 'must be a bare host name' })
  domain!: string;

  @ApiProperty({ type: String, maxLength: 254, format: 'email', example: 'dev@example.com' })
  @Transform(ifString((email) => email.trim()))
  @IsString()
  @MaxLength(254)
  @Matches(EMAIL, { message: 'must be an email address' })
  email!: string;
}
