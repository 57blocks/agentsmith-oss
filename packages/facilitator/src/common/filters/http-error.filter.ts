import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from '../logger.js';
import { LOG } from '../tokens.js';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(@Inject(LOG) private readonly log: Logger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      if (error.getStatus() === 404) {
        response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
        return;
      }
      response.status(error.getStatus()).json(error.getResponse());
      return;
    }

    const tooLarge = error instanceof Error && 'type' in error && error.type === 'entity.too.large';
    this.log.error('http_unhandled_error', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    response.status(tooLarge ? 413 : 500).json({
      error: {
        code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR',
        message: tooLarge ? 'Request body is too large' : 'Internal server error',
      },
    });
  }
}
