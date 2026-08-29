import dotenv from 'dotenv';
import { envSchema } from './schema.js';
import { logger } from '../logger/index.js';

dotenv.config();

/**
 * Validate and load environment. Throws if anything is missing/invalid.
 * Runs once at startup; the validated values are exported as `config`.
 */
function loadConfig() {
  const out = {};
  const errors = [];

  for (const [key, rule] of Object.entries(envSchema)) {
    let raw = process.env[key];
    if (raw === undefined || raw === '') {
      if (rule.required) {
        errors.push(rule.message || `${key} is required`);
        continue;
      }
      raw = rule.default;
    }

    let value = raw;
    switch (rule.type) {
      case 'port': {
        const n = parseInt(value, 10);
        if (Number.isNaN(n) || n <= 0 || n > 65535) {
          errors.push(`${key} must be a valid port number`);
          break;
        }
        value = n;
        break;
      }
      case 'number': {
        const n = Number(value);
        if (Number.isNaN(n)) errors.push(`${key} must be a number`);
        value = n;
        break;
      }
      case 'enum': {
        if (!rule.values.includes(value)) {
          errors.push(`${key} must be one of: ${rule.values.join(', ')}`);
        }
        break;
      }
      case 'string': {
        if (rule.minLength && value.length < rule.minLength) {
          errors.push(rule.message || `${key} must be at least ${rule.minLength} characters`);
        }
        break;
      }
      default:
        break;
    }
    out[key] = value;
  }

  if (errors.length) {
    const msg = `Invalid environment configuration:\n - ${errors.join('\n - ')}`;
    logger.error(msg);
    throw new Error(msg);
  }

  return out;
}

export const config = loadConfig();

