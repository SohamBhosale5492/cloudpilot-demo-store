import express from 'express';
import { initTelemetry } from './telemetry';
import { Logger } from './logger';
import { initMetrics } from './metrics';
import { createOrderRoutes } from './routes';

const SERVICE_NAME = 'order-service';
const PORT = Number(process.env.PORT || 4002);

initTelemetry(SERVICE_NAME);
initMetrics(SERVICE_NAME);

const logger = new Logger(SERVICE_NAME);
const app = express();

app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path !== '/metrics' && req.path !== '/health' && req.path !== '/ready') {
      logger.info(`${req.method} ${req.path} ${res.statusCode}`, {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - start,
      });
    }
  });
  next();
});

app.use(createOrderRoutes(logger));

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Order Service listening on port ${PORT}`);
});

export { app, server };
