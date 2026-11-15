import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

export function isHealthEndpointConfigured(serviceName: string, endpoint: string): boolean {
  const configPath =
    process.env.HEALTH_CONFIG_PATH ||
    path.resolve(process.cwd(), '../config/observability/health-checks.yaml');

  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.parse(raw);
      const list = parsed?.health_checks || [];
      return list.some((hc: any) => hc.service === serviceName && hc.endpoint === endpoint);
    }
  } catch {
    // Ignore error
  }
  return true;
}

export async function handleHealth(serviceName: string) {
  return {
    status: 'UP',
    service: serviceName,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}

export async function handleReady(
  serviceName: string,
  productServiceUrl: string,
  orderServiceUrl: string
) {
  let productsOk = false;
  let ordersOk = false;

  try {
    const res = await fetch(`${productServiceUrl}/health`, { signal: AbortSignal.timeout(2000) });
    productsOk = res.ok;
  } catch {
    productsOk = false;
  }

  try {
    const res = await fetch(`${orderServiceUrl}/health`, { signal: AbortSignal.timeout(2000) });
    ordersOk = res.ok;
  } catch {
    ordersOk = false;
  }

  const isReady = productsOk && ordersOk;

  return {
    status: isReady ? 'READY' : 'DEGRADED',
    service: serviceName,
    checks: {
      productService: productsOk ? 'reachable' : 'unreachable',
      orderService: ordersOk ? 'reachable' : 'unreachable',
    },
    timestamp: new Date().toISOString(),
  };
}
