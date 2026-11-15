import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'store_' });

let productViewsCounter: client.Counter<string> | null = null;

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
        if (m.service === serviceName && m.name === 'store_product_views_total') {
          productViewsCounter = new client.Counter({
            name: 'store_product_views_total',
            help: 'Total number of product view requests',
            labelNames: ['service', 'route', 'method', 'product_id'],
            registers: [register],
          });
        }
      }
    }
  } catch {
    // Ignore config read error
  }

  // Fallback if not registered from config
  if (!productViewsCounter) {
    productViewsCounter = new client.Counter({
      name: 'store_product_views_total',
      help: 'Total number of product view requests',
      labelNames: ['service', 'route', 'method', 'product_id'],
      registers: [register],
    });
  }

  return register;
}

export function recordProductView(route: string, method: string, productId: string) {
  if (productViewsCounter) {
    productViewsCounter.inc({
      service: 'product-service',
      route,
      method,
      product_id: productId,
    });
  }
}

export function getMetricsRegister() {
  return register;
}
