/**
 * Environment-variable schema. All keys are required unless `required: false`.
 * Throws on startup if any required var is missing or invalid.
 */
export const envSchema = {
  PORT: {
    required: false,
    default: 4000,
    type: 'port',
  },
  ALLOWED_ORIGIN: {
    required: false,
    default: 'http://localhost:5173',
    type: 'string',
  },
  LOG_LEVEL: {
    required: false,
    default: 'info',
    type: 'enum',
    values: ['debug', 'info', 'warn', 'error'],
  },
  NODE_ENV: {
    required: false,
    default: 'development',
    type: 'enum',
    values: ['development', 'production', 'test'],
  },

  /* ---- Auth ---- */
  JWT_SECRET: {
    required: true,
    type: 'string',
    minLength: 16,
    message: 'JWT_SECRET must be at least 16 characters (use a random string)',
  },
  JWT_EXPIRES_IN: {
    required: false,
    default: '7d',
    type: 'string',
  },

  /* ---- DB ---- */
  MONGO_URI: {
    required: false,
    default: 'mongodb://127.0.0.1:27017/mdev',
    type: 'string',
  },
};

