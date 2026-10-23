import {
  Controller,
  Delete,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AdminIdParamsDto } from './dto/admin-id-params.dto.js';
import { AdminIdValidationPipe } from './dto/credentials-validation.pipe.js';
import { AdminGuard, type AdminRequest } from './guards/admin.guard.js';
import {
  AdminKeysService,
  NotFoundError,
  ServerDisabledError,
} from './services/admin-keys.service.js';

const NOT_FOUND = new HttpException({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
const SERVER_DISABLED = new HttpException(
  { error: { code: 'SERVER_DISABLED', message: 'The Resource Server is disabled' } },
  409,
);

/** Admin routes on Resource Server keys; a local extension, not part of x402. */
@Controller('admin')
@ApiExcludeController()
@UseGuards(AdminGuard)
export class AdminController {
  constructor(@Inject(AdminKeysService) private readonly keys: AdminKeysService) {}

  @Post('servers/:id/keys')
  async issue(
    @Param(new AdminIdValidationPipe()) { id }: AdminIdParamsDto,
    @Req() request: AdminRequest,
  ): Promise<{ credentialId: string; apiKey: string }> {
    try {
      return await this.keys.issue(request.admin, id);
    } catch (error) {
      if (error instanceof NotFoundError) throw NOT_FOUND;
      if (error instanceof ServerDisabledError) throw SERVER_DISABLED;
      throw error;
    }
  }

  @Delete('keys/:id')
  @HttpCode(204)
  async revoke(
    @Param(new AdminIdValidationPipe()) { id }: AdminIdParamsDto,
    @Req() request: AdminRequest,
  ): Promise<void> {
    try {
      await this.keys.revoke(request.admin, id);
    } catch (error) {
      if (error instanceof NotFoundError) throw NOT_FOUND;
      throw error;
    }
  }
}
