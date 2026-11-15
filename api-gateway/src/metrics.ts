import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'store_' });

let httpRequestsCounter: client.Counter<string> | null = null;

export function initMetrics(serviceName: string) {
  const configPath =
    process.env.METRICS_CONFIG_PATH ||
    path.resolve(process.cwd(), '../config/observability/metrics.yaml');

  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.parse(raw);
      const metricsList = parsed?.metrics || [];

      for (const m of metricsList) {
        if (m.service === serviceName && m.name === 'store_http_requests_total') {
          httpRequestsCounter = new client.Counter({
            name: 'store_http_requests_total',
            help: 'Total number of HTTP requests processed by API Gateway',
            labelNames: ['service', 'route', 'method', 'status_code'],
            registers: [register],
          });
        }
      }
    }
  } catch {
    // Ignore config read error
  }

  // Fallback registration
  if (!httpRequestsCounter) {
    httpRequestsCounter = new client.Counter({
      name: 'store_http_requests_total',
      help: 'Total number of HTTP requests processed by API Gateway',
      labelNames: ['service', 'route', 'method', 'status_code'],
      registers: [register],
    });
  }

  return register;
}

export function recordHttpRequest(route: string, method: string, statusCode: number | string) {
  if (httpRequestsCounter) {
    httpRequestsCounter.inc({
      service: 'api-gateway',
      route,
      method,
      status_code: String(statusCode),
    });
  }
}

export function getMetricsRegister() {
  return register;
}
