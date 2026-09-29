import { bootstrap } from './app.js';
import { closeDb, getDb } from './db/connection.js';
import { config } from './config/env.js';
import { logger } from './utils/logger.js';

const app = bootstrap();
const db = getDb();

const server = app.listen(config.server.port, config.server.host, () => {
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM bases)           AS bases,
         (SELECT COUNT(*) FROM equipment_types) AS equipment_types,
         (SELECT COUNT(*) FROM users)           AS users,
         (SELECT COUNT(*) FROM stock_ledger)    AS ledger_entries`,
    )
    .get() as Record<string, number>;

  logger.info(
    {
      url: `http://${config.server.host}:${config.server.port}`,
      env: config.env,
      ...counts,
    },
    `MiL-AMS API ready - ${counts.bases} bases, ${counts.users} users, ${counts.ledger_entries} ledger entries`,
  );

  if (counts.users === 0) {
    logger.warn('No users exist. Run `npm run db:seed` to load the demo dataset and role accounts.');
  }
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down');
  server.close(() => {
    closeDb();
    logger.info('Shutdown complete');
    process.exit(0);
  });

  // Do not let a hung connection block the deploy indefinitely.
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception - exiting');
  closeDb();
  process.exit(1);
});
