import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Absolute path to the `server/` package root (src/ lives one level below it). */
export const SERVER_ROOT = path.resolve(here, '..', '..');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_FILE: z.string().default('./data/milams.db'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  SEED_ADMIN_USERNAME: z.string().default('admin'),
  SEED_ADMIN_PASSWORD: z.string().default('Admin@12345'),
  SEED_ADMIN_NAME: z.string().default('System Administrator'),

  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Invalid environment configuration:\n${issues}\n\nCopy Backend_Army/.env.example to Backend_Army/.env and fill it in.`);

}

const raw = parsed.data;

if (raw.NODE_ENV === 'production' && raw.JWT_SECRET.includes('insecure')) {
  throw new Error('Refusing to start in production with the example JWT_SECRET. Generate a real secret.');
}

export const config = {
  env: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  server: {
    port: raw.PORT,
    host: raw.HOST,
  },
  logLevel: raw.LOG_LEVEL,
  db: {
    /** Absolute path, or the literal ':memory:'. */
    file: raw.DATABASE_FILE === ':memory:'
      ? ':memory:'
      : path.isAbsolute(raw.DATABASE_FILE)
        ? raw.DATABASE_FILE
        : path.resolve(SERVER_ROOT, raw.DATABASE_FILE),
  },
  auth: {
    jwtSecret: raw.JWT_SECRET,
    jwtExpiresIn: raw.JWT_EXPIRES_IN,
    bcryptRounds: raw.BCRYPT_ROUNDS,
  },
  cors: {
    origins: raw.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
  },
  seed: {
    adminUsername: raw.SEED_ADMIN_USERNAME,
    adminPassword: raw.SEED_ADMIN_PASSWORD,
    adminName: raw.SEED_ADMIN_NAME,
  },
  rateLimit: {
    windowMs: raw.RATE_LIMIT_WINDOW_MINUTES * 60_000,
    max: raw.RATE_LIMIT_MAX,
    authMax: raw.AUTH_RATE_LIMIT_MAX,
  },
} as const;

export type AppConfig = typeof config;
