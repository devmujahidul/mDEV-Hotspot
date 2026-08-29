import express from 'express';
import cors from 'cors';
import http from 'http';
import { config } from './config/index.js';
import { logger } from './logger/index.js';
import { connect } from './db/mongoose.js';
import apiRouter from './routes/index.js';
import installController from './controllers/install.controller.js';
import { notFoundMiddleware } from './middlewares/notFound.js';
import { errorMiddleware } from './middlewares/error.js';
import { attachWebSocket } from './websocket/hub.js';

async function start() {
  // Connect to Mongo first so the rest of the stack can rely on it.
  const connection = await connect(config.MONGO_URI);

  // Drop stale model indexes and (re)build the ones declared on the
  // schemas (e.g. the globally-unique MAC index).  safe=true so an index
  // build failure is logged rather than taking the server down.
  try {
    await connection.syncIndexes();
    logger.info('Mongo indexes synced');
  } catch (err) {
    logger.warn('Index sync failed (continuing): ' + err.message);
  }

  const app = express();

  app.use(cors({ origin: config.ALLOWED_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: true, limit: '16kb' }));

  // Per-request access log (compact, only for /api to avoid noise on /health)
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api')) {
        logger.debug(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
      }
    });
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // Public, unauthenticated install + agent download endpoints.
  // Mounted at the root so the curl one-liner is short: `curl host:4000/install.sh`.
  app.use(installController);

  app.use('/api', apiRouter);

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  const server = http.createServer(app);
  attachWebSocket(server);

  server.listen(config.PORT, () => {
    logger.info(`HTTP+WS listening on http://localhost:${config.PORT}`);
    logger.info('WebSocket path: /ws');
    logger.info('Install script: GET /install.sh');
    logger.info('Agent binary:   GET /agent/:arch');
  });
}

start().catch((err) => {
  logger.error('Fatal startup error: ' + err.message);
  logger.error(err.stack);
  process.exit(1);
});


