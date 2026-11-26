import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'store_' });

let ordersPlacedCounter: client.Counter<string> | null = null;
let httpRequestsCounter: client.Counter<string> | null = null;

function ensureHttpRequestsCounter(): client.Counter<string> {
  if (!httpRequestsCounter) {
    const existing = register.getSingleMetric('store_http_requests_total');
    httpRequestsCounter = existing
      ? (existing as client.Counter<string>)
      : new client.Counter({
          name: 'store_http_requests_total',
          help: 'Total number of HTTP requests processed by Order Service',
          labelNames: ['service', 'route', 'method', 'status_code'],
          registers: [register],
        });
  }
  return httpRequestsCounter;
}

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
          ensureHttpRequestsCounter();
        }
        // Check if store_orders_placed_total is configured in metrics.yaml
        if (m.service === serviceName && m.name === 'store_orders_placed_total' && !ordersPlacedCounter) {
          const existingOrders = register.getSingleMetric('store_orders_placed_total');
          ordersPlacedCounter = existingOrders
            ? (existingOrders as client.Counter<string>)
            : new client.Counter({
                name: 'store_orders_placed_total',
                help: 'Total number of successfully placed orders',
                labelNames: ['service', 'route', 'method', 'status'],
                registers: [register],
              });
        }
      }
    }
  } catch {
    // Ignore config read error
  }

  // Fallback registration for HTTP request counter (consistent with api-gateway)
  ensureHttpRequestsCounter();

  // NOTE: If not in metrics.yaml, ordersPlacedCounter remains null!
  // This is the intentional observability gap for CloudPilot to detect.
  return register;
}

export function recordHttpRequest(route: string, method: string, statusCode: number | string) {
  if (httpRequestsCounter) {
    httpRequestsCounter.inc({
      service: 'order-service',
      route,
      method,
      status_code: String(statusCode),
    });
  }
}

export function recordOrderPlaced(status: 'success' | 'failed') {
  if (ordersPlacedCounter) {
    ordersPlacedCounter.inc({
      service: 'order-service',
      route: '/orders',
      method: 'POST',
      status,
    });
  }
}

export function getMetricsRegister() {
  return register;
}
