#!/usr/bin/env node

/**
 * CloudPilot Demo Store - System Verification Script
 * Validates configuration files, intentional observability gaps, and live service endpoints.
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const ROOT_DIR = path.resolve(__dirname, '..');

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function logHeader(title) {
  console.log(`\n${COLORS.bold}${COLORS.cyan}================================================================${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.cyan}  ${title}${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.cyan}================================================================${COLORS.reset}`);
}

function logCheck(name, passed, detail) {
  const icon = passed ? `${COLORS.green}[PASS]${COLORS.reset}` : `${COLORS.red}[FAIL]${COLORS.reset}`;
  console.log(`  ${icon} ${name}${detail ? ` - ${COLORS.yellow}${detail}${COLORS.reset}` : ''}`);
}

function logGap(name, detected, detail) {
  const icon = detected ? `${COLORS.yellow}[GAP DETECTED]${COLORS.reset}` : `${COLORS.red}[GAP MISSING]${COLORS.reset}`;
  console.log(`  ${icon} ${name}: ${detail}`);
}

async function verifyConfigs() {
  logHeader('1. Observability Configuration Files & Intentional Gaps');

  // Metrics
  const metricsFile = path.join(ROOT_DIR, 'config/observability/metrics.yaml');
  const metricsExists = fs.existsSync(metricsFile);
  logCheck('config/observability/metrics.yaml exists', metricsExists);

  if (metricsExists) {
    const parsed = yaml.parse(fs.readFileSync(metricsFile, 'utf8'));
    const names = (parsed.metrics || []).map((m) => m.name);
    logCheck('Contains store_http_requests_total', names.includes('store_http_requests_total'));
    logCheck('Contains store_product_views_total', names.includes('store_product_views_total'));

    const hasOrderMetric = names.includes('store_orders_placed_total');
    logGap(
      'Metric Gap',
      !hasOrderMetric,
      'store_orders_placed_total is absent in metrics.yaml (Ready for CloudPilot detection)'
    );
  }

  // Health Checks
  const healthFile = path.join(ROOT_DIR, 'config/observability/health-checks.yaml');
  const healthExists = fs.existsSync(healthFile);
  logCheck('config/observability/health-checks.yaml exists', healthExists);

  if (healthExists) {
    const parsed = yaml.parse(fs.readFileSync(healthFile, 'utf8'));
    const checks = parsed.health_checks || [];
    const hasOrderReady = checks.some((c) => c.service === 'order-service' && c.endpoint === '/ready');
    logCheck('Order Service /ready registration', hasOrderReady,
      hasOrderReady ? 'registered in health-checks.yaml' : 'missing from health-checks.yaml');
  }

  // Tracing
  const tracingFile = path.join(ROOT_DIR, 'config/observability/tracing.yaml');
  const tracingExists = fs.existsSync(tracingFile);
  logCheck('config/observability/tracing.yaml exists', tracingExists);

  if (tracingExists) {
    const parsed = yaml.parse(fs.readFileSync(tracingFile, 'utf8'));
    const orderTracingDisabled = parsed.services?.['order-service']?.enabled === false;
    logGap(
      'Tracing Gap',
      orderTracingDisabled,
      'order-service tracing is set to enabled: false (Spans omitted from Jaeger traces)'
    );
  }

  // Alert Rules
  const alertFile = path.join(ROOT_DIR, 'config/observability/alert-rules.yaml');
  const alertExists = fs.existsSync(alertFile);
  logCheck('config/observability/alert-rules.yaml exists', alertExists);

  if (alertExists) {
    const parsed = yaml.parse(fs.readFileSync(alertFile, 'utf8'));
    const rules = (parsed.groups || []).flatMap((group) => group.rules || []);
    const orderHeartbeat = rules.find((rule) => rule.alert === 'store_order_service_heartbeat_alert');
    const validOrderHeartbeat = orderHeartbeat?.expr === 'up{job="order-service"} == 0'
      && orderHeartbeat?.labels?.severity === 'warning';
    logCheck('Order Service heartbeat alert', validOrderHeartbeat,
      validOrderHeartbeat ? 'loaded configuration is present' : 'missing or invalid alert configuration');
  }
}

async function verifyLiveEndpoints() {
  logHeader('2. Live Endpoint Probes (if services are running)');

  const endpoints = [
    { name: 'API Gateway Health', url: 'http://127.0.0.1:4000/health', expectedStatus: 200 },
    { name: 'API Gateway Ready', url: 'http://127.0.0.1:4000/ready', expectedStatus: 200 },
    { name: 'API Gateway Metrics', url: 'http://127.0.0.1:4000/metrics', expectedStatus: 200 },
    { name: 'Product Service Health', url: 'http://127.0.0.1:4001/health', expectedStatus: 200 },
    { name: 'Product Service Ready', url: 'http://127.0.0.1:4001/ready', expectedStatus: 200 },
    { name: 'Product Service Metrics', url: 'http://127.0.0.1:4001/metrics', expectedStatus: 200 },
    { name: 'Order Service Health', url: 'http://127.0.0.1:4002/health', expectedStatus: 200 },
    { name: 'Order Service Ready', url: 'http://127.0.0.1:4002/ready', expectedStatus: 200 },
    { name: 'Order Service Metrics', url: 'http://127.0.0.1:4002/metrics', expectedStatus: 200 },
    { name: 'Prometheus Server', url: 'http://127.0.0.1:9090/-/ready', expectedStatus: 200, optional: true },
    { name: 'Jaeger Query UI', url: 'http://127.0.0.1:16686/', expectedStatus: 200, optional: true },
    { name: 'Grafana Loki Ready', url: 'http://127.0.0.1:3100/ready', expectedStatus: 200, optional: true },
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, { signal: AbortSignal.timeout(2000) });
      const passed = res.status === ep.expectedStatus;
      logCheck(ep.name, passed, `HTTP ${res.status} (expected ${ep.expectedStatus})`);
    } catch (err) {
      if (ep.optional) {
        console.log(`  ${COLORS.yellow}[STANDBY]${COLORS.reset} ${ep.name} - Container not running yet (docker compose up -d)`);
      } else {
        logCheck(ep.name, false, `Unreachable (${err.message})`);
      }
    }
  }
}

async function main() {
  console.log(`${COLORS.bold}CloudPilot Demo Store — Verification Suite${COLORS.reset}`);
  await verifyConfigs();
  await verifyLiveEndpoints();
  console.log(`\n${COLORS.bold}${COLORS.green}Verification completed.${COLORS.reset}\n`);
}

main().catch((err) => {
  console.error('Verification error:', err);
  process.exit(1);
});
