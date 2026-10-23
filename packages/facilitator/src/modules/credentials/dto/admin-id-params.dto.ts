import { IsUUID } from 'class-validator';

/** `:id` of the admin routes. Loose: any 8-4-4-4-12 hexadecimal UUID, never trimmed. */
export class AdminIdParamsDto {
  @IsUUID('loose')
  id!: string;
}
