import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { config } from './config/env.js';
import { logger } from './utils/logger.js';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { migrate } from './db/migrate.js';
import { authRouter } from './modules/auth.routes.js';
import { catalogueRouter } from './modules/catalogue.routes.js';
import { dashboardRouter } from './modules/dashboard.routes.js';
import { purchaseRouter } from './modules/purchases.routes.js';
import { transferRouter } from './modules/transfers.routes.js';
import { assignmentRouter } from './modules/assignments.routes.js';
import { expenditureRouter } from './modules/expenditures.routes.js';
import { openingBalanceRouter } from './modules/openingBalances.routes.js';
import { ledgerRouter } from './modules/ledger.routes.js';
import { adminRouter } from './modules/admin.routes.js';
import { auditRouter } from './modules/audit.routes.js';

export function createApp(): Express {
  const app = express();

  // Behind a reverse proxy in production, so `req.ip` (recorded in the audit
  // trail) is the real client address rather than the proxy's.
  app.set('trust proxy', config.isProduction ? 1 : false);
  app.disable('x-powered-by');

  // Registered before the HTTP logger so the id `requestContext` generates is the
  // same one that appears in the log line, the audit row and the ledger postings.
  app.use(requestContext);

  applySecurity(app);
  applyLogging(app);
  applyParsing(app);
  applyRateLimits(app);

  app.get('/health', (_req, res) => {
    res.json({ data: { status: 'ok', service: 'milams-api', env: config.env, time: new Date().toISOString() } });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/catalogue', catalogueRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/purchases', purchaseRouter);
  app.use('/api/transfers', transferRouter);
  app.use('/api/assignments', assignmentRouter);
  app.use('/api/expenditures', expenditureRouter);
  app.use('/api/opening-balances', openingBalanceRouter);
  app.use('/api/ledger', ledgerRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/audit-logs', auditRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

function applySecurity(app: Express): void {
  app.use(
    helmet({
      // The API serves JSON only and is consumed by a separate dev origin; the
      // strict default CSP would otherwise block the Vite dev server's HMR
      // websocket. The SPA ships its own CSP via its hosting layer.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin: true,
      credentials: true,
      exposedHeaders: ['X-Request-Id'],
    }),
  );
}

function applyLogging(app: Express): void {
  // One JSON line per request, correlated by requestId. Redaction of the
  // Authorization header is configured on the logger instance itself.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as { ctx?: { requestId?: string } }).ctx?.requestId ?? 'unknown',
      customLogLevel(_req, res, error) {
        if (error || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      customSuccessMessage(req, res) {
        return `${req.method} ${req.url} -> ${res.statusCode}`;
      },
      serializers: {
        req(req) {
          return { id: req.id, method: req.method, url: req.url };
        },
        res(res) {
          return { statusCode: res.statusCode };
        },
      },
    }),
  );
}

function applyParsing(app: Express): void {
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(compression());
}

function applyRateLimits(app: Express): void {
  app.use(
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
      standardHeaders: true,
      legacyHeaders: false,
      skip: () => config.isTest,
      message: {
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' },
      },
    }),
  );
}

/** Create the schema on boot so a fresh checkout runs with one command. */
export function bootstrap(): Express {
  migrate();
  return createApp();
}
