import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from '../logger.js';

/** Tags each request with an `x-request-id` (the caller's, or a new one) and logs it on finish. */
export function requestLogger(log: Logger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = req.get('x-request-id') || randomUUID();
    res.setHeader('x-request-id', requestId);
    const startedAt = Date.now();
    res.on('finish', () =>
      log.info('http_request', {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      }),
    );
    next();
  };
}
