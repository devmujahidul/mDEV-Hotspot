import mongoose from 'mongoose';
import { logger } from '../logger/index.js';

let connecting = null;

/**
 * Connect to MongoDB.  Reuses a single promise if connect() is called
 * multiple times concurrently.
 */
export async function connect(uri) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (connecting) return connecting;

  connecting = mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
  }).then((m) => {
    logger.info(`MongoDB connected: ${m.connection.host}/${m.connection.name}`);
    return m.connection;
  }).catch((err) => {
    connecting = null;
    throw err;
  });

  return connecting;
}

export async function disconnect() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    connecting = null;
  }
}
