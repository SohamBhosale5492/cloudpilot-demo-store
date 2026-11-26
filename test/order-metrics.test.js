const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const yaml = require('yaml');

describe('Order Service HTTP Metrics Regression Tests', () => {
  const rootDir = path.resolve(__dirname, '..');
  let orderServer;
  let mockProductServer;
  let baseUrl;
  let prevPort;
  let prevProductUrl;
  let prevMetricsPath;
  let prevHealthPath;
  let prevTracingPath;
  let prevLokiUrl;
  let prevDatabaseUrl;

  before(async () => {
    prevPort = process.env.PORT;
    prevProductUrl = process.env.PRODUCT_SERVICE_URL;
    prevMetricsPath = process.env.METRICS_CONFIG_PATH;
    prevHealthPath = process.env.HEALTH_CONFIG_PATH;
    prevTracingPath = process.env.TRACING_CONFIG_PATH;
    prevLokiUrl = process.env.LOKI_PUSH_URL;
    prevDatabaseUrl = process.env.DATABASE_URL;

    mockProductServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.endsWith('/reserve')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, remainingStock: 10 }));
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/products/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'prod-1', price: 49.99 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => mockProductServer.listen(0, '127.0.0.1', resolve));
    const mockPort = mockProductServer.address().port;

    process.env.PORT = '0';
    process.env.PRODUCT_SERVICE_URL = `http://127.0.0.1:${mockPort}`;
    process.env.METRICS_CONFIG_PATH = path.join(rootDir, 'config/observability/metrics.yaml');
    process.env.HEALTH_CONFIG_PATH = path.join(rootDir, 'config/observability/health-checks.yaml');
    process.env.TRACING_CONFIG_PATH = path.join(rootDir, 'config/observability/tracing.yaml');
    delete process.env.LOKI_PUSH_URL;
    delete process.env.DATABASE_URL;

    const orderModule = require('../order-service/dist/index.js');
    orderServer = orderModule.server;
    if (!orderServer.listening) {
      await new Promise((resolve) => orderServer.once('listening', resolve));
    }
    const orderPort = orderServer.address().port;
    baseUrl = `http://127.0.0.1:${orderPort}`;
  });

  after(async () => {
    if (orderServer) await new Promise((resolve) => orderServer.close(resolve));
    if (mockProductServer) await new Promise((resolve) => mockProductServer.close(resolve));
    if (prevPort === undefined) delete process.env.PORT; else process.env.PORT = prevPort;
    if (prevProductUrl === undefined) delete process.env.PRODUCT_SERVICE_URL; else process.env.PRODUCT_SERVICE_URL = prevProductUrl;
    if (prevMetricsPath === undefined) delete process.env.METRICS_CONFIG_PATH; else process.env.METRICS_CONFIG_PATH = prevMetricsPath;
    if (prevHealthPath === undefined) delete process.env.HEALTH_CONFIG_PATH; else process.env.HEALTH_CONFIG_PATH = prevHealthPath;
    if (prevTracingPath === undefined) delete process.env.TRACING_CONFIG_PATH; else process.env.TRACING_CONFIG_PATH = prevTracingPath;
    if (prevLokiUrl === undefined) delete process.env.LOKI_PUSH_URL; else process.env.LOKI_PUSH_URL = prevLokiUrl;
    if (prevDatabaseUrl !== undefined) process.env.DATABASE_URL = prevDatabaseUrl;
  });

  test('metrics.yaml includes order-service store_http_requests_total while preserving store_orders_placed_total gap', () => {
    const metricsPath = path.join(rootDir, 'config/observability/metrics.yaml');
    const parsed = yaml.parse(fs.readFileSync(metricsPath, 'utf8'));
    const metrics = parsed.metrics || [];

    const orderHttp = metrics.find(
      (m) => m.service === 'order-service' && m.name === 'store_http_requests_total'
    );
    assert.ok(orderHttp, 'order-service store_http_requests_total must be configured');
    assert.strictEqual(orderHttp.route, '/orders');
    assert.strictEqual(orderHttp.method, 'POST');

    const ordersPlaced = metrics.find((m) => m.name === 'store_orders_placed_total');
    assert.strictEqual(ordersPlaced, undefined, 'store_orders_placed_total intentional gap must be preserved');
  });

  test('POST /orders increments store_http_requests_total for 201, 400, and 402 without double-counting and excludes /health, /ready, /metrics', async () => {
    const okRes = await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: 'cust-metrics-1',
        items: [{ productId: 'prod-1', quantity: 1 }],
        paymentMethod: 'credit_card',
      }),
    });
    assert.strictEqual(okRes.status, 201);

    const badRes = await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: 'cust-metrics-2', items: [] }),
    });
    assert.strictEqual(badRes.status, 400);

    const declinedRes = await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: 'cust-metrics-3',
        items: [{ productId: 'prod-1', quantity: 1 }],
        paymentMethod: 'credit_card',
        cardNumber: '4002-0000-0000-0000',
      }),
    });
    assert.strictEqual(declinedRes.status, 402);

    // Health, readiness, and metrics endpoints should not be counted
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.strictEqual(healthRes.status, 200);
    const readyRes = await fetch(`${baseUrl}/ready`);
    assert.strictEqual(readyRes.status, 200);
    assert.strictEqual((await readyRes.json()).status, 'READY');

    const metricsRes = await fetch(`${baseUrl}/metrics`);
    assert.strictEqual(metricsRes.status, 200);
    const metricsText = await metricsRes.text();

    assert.match(
      metricsText,
      /store_http_requests_total\{[^}]*service="order-service"[^}]*route="\/orders"[^}]*method="POST"[^}]*status_code="201"[^}]*\}\s+1\b/
    );
    assert.match(
      metricsText,
      /store_http_requests_total\{[^}]*service="order-service"[^}]*route="\/orders"[^}]*method="POST"[^}]*status_code="400"[^}]*\}\s+1\b/
    );
    assert.match(
      metricsText,
      /store_http_requests_total\{[^}]*service="order-service"[^}]*route="\/orders"[^}]*method="POST"[^}]*status_code="402"[^}]*\}\s+1\b/
    );

    assert.doesNotMatch(metricsText, /route="\/health"/);
    assert.doesNotMatch(metricsText, /route="\/ready"/);
    assert.doesNotMatch(metricsText, /route="\/metrics"/);
    assert.doesNotMatch(metricsText, /store_orders_placed_total/);
  });
});
