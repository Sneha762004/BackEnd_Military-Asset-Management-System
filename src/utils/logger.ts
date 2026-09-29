import pino from 'pino';
import { config } from '../config/env.js';

/**
 * Structured application log (JSON in production, human-readable in dev).
 * The HTTP layer uses `pino-http` on top of this instance so every request is
 * correlated by `requestId`, which is also written to `audit_logs.request_id`
 * and `stock_ledger.request_id` - one identifier ties an API call, its log
 * lines and its ledger postings together.
 */
export const logger = pino({
  level: config.logLevel,
  base: { service: 'milams-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      'body.password',
      'body.currentPassword',
    ],
    censor: '[redacted]',
  },
  transport: config.isProduction
    ? undefined
    : {
        target: 'pino/file',
        options: { destination: 1 },
      },
});

export type Logger = typeof logger;
