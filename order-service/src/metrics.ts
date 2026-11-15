import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'store_' });

let ordersPlacedCounter: client.Counter<string> | null = null;

export function initMetrics(serviceName: string) {
  const configPath =
    process.env.METRICS_CONFIG_PATH ||
    path.resolve(process.cwd(), '../config/observability/metrics.yaml');

  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.parse(raw);
      const metricsList = parsed?.metrics || [];

      // Check if store_orders_placed_total is configured in metrics.yaml
      for (const m of metricsList) {
        if (m.service === serviceName && m.name === 'store_orders_placed_total') {
          ordersPlacedCounter = new client.Counter({
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

  // NOTE: If not in metrics.yaml, ordersPlacedCounter remains null!
  // This is the intentional observability gap for CloudPilot to detect.
  return register;
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
