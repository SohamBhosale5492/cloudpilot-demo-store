import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { checkDbConnection } from './db';

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
  return true; // Default fallback if config file missing
}

export async function handleHealth(serviceName: string) {
  return {
    status: 'UP',
    service: serviceName,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}

export async function handleReady(serviceName: string) {
  const isHealthy = await checkDbConnection();
  return {
    status: isHealthy ? 'READY' : 'DEGRADED',
    service: serviceName,
    checks: {
      database: isHealthy ? 'connected' : 'disconnected',
    },
    timestamp: new Date().toISOString(),
  };
}
