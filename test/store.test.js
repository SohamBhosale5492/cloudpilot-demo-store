const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const yaml = require('yaml');

describe('CloudPilot Demo Store - Unit and Integration Tests', () => {
  const rootDir = path.resolve(__dirname, '..');

  describe('Observability Configuration Gaps', () => {
    test('metrics.yaml has intentional gap: store_orders_placed_total is missing', () => {
      const metricsPath = path.join(rootDir, 'config/observability/metrics.yaml');
      assert.ok(fs.existsSync(metricsPath), 'metrics.yaml should exist');
      const content = yaml.parse(fs.readFileSync(metricsPath, 'utf8'));
      const metricNames = (content.metrics || []).map((m) => m.name);
      assert.ok(metricNames.includes('store_http_requests_total'), 'gateway metric present');
      assert.ok(metricNames.includes('store_product_views_total'), 'product metric present');
      assert.strictEqual(
        metricNames.includes('store_orders_placed_total'),
        false,
        'store_orders_placed_total must be absent to provide intentional gap for CloudPilot'
      );
    });

    test('health-checks.yaml registers order-service /ready once at a 30-second interval', () => {
      const healthPath = path.join(rootDir, 'config/observability/health-checks.yaml');
      assert.ok(fs.existsSync(healthPath), 'health-checks.yaml should exist');
      const content = yaml.parse(fs.readFileSync(healthPath, 'utf8'));
      const checks = content.health_checks || [];
      const orderReady = checks.filter((c) => c.service === 'order-service' && c.endpoint === '/ready');
      assert.deepStrictEqual(orderReady, [{ service: 'order-service', endpoint: '/ready', interval_seconds: 30 }]);
    });

    test('tracing.yaml has intentional gap: order-service is disabled', () => {
      const tracingPath = path.join(rootDir, 'config/observability/tracing.yaml');
      assert.ok(fs.existsSync(tracingPath), 'tracing.yaml should exist');
      const content = yaml.parse(fs.readFileSync(tracingPath, 'utf8'));
      assert.strictEqual(content.services?.['order-service']?.enabled, false, 'order-service tracing must be disabled');
    });

    test('alert-rules.yaml has intentional gap: order-service heartbeat alert is missing', () => {
      const alertPath = path.join(rootDir, 'config/observability/alert-rules.yaml');
      assert.ok(fs.existsSync(alertPath), 'alert-rules.yaml should exist');
      const content = yaml.parse(fs.readFileSync(alertPath, 'utf8'));
      const rules = content.groups?.[0]?.rules || [];
      const orderAlert = rules.find((r) => r.alert?.includes('order_service'));
      assert.strictEqual(orderAlert, undefined, 'order-service heartbeat alert must be absent');
    });
  });

  describe('Microservices In-Process Behavior', () => {
    let productServer, orderServer, gatewayServer;
    let productUrl, orderUrl, gatewayUrl;
    let tracingDirectory;
    const previousEnv = {};
    const envKeys = [
      'PORT', 'PRODUCT_SERVICE_URL', 'ORDER_SERVICE_URL', 'DATABASE_URL', 'LOKI_PUSH_URL',
      'HEALTH_CONFIG_PATH', 'METRICS_CONFIG_PATH', 'TRACING_CONFIG_PATH',
    ];

    async function boundUrl(server) {
      if (!server.listening) await once(server, 'listening');
      return `http://127.0.0.1:${server.address().port}`;
    }

    before(async () => {
      for (const key of envKeys) previousEnv[key] = process.env[key];
      process.env.PORT = '0';
      process.env.HEALTH_CONFIG_PATH = path.join(rootDir, 'config/observability/health-checks.yaml');
      process.env.METRICS_CONFIG_PATH = path.join(rootDir, 'config/observability/metrics.yaml');
      delete process.env.DATABASE_URL;
      delete process.env.LOKI_PUSH_URL;
      tracingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-store-test-tracing-'));
      process.env.TRACING_CONFIG_PATH = path.join(tracingDirectory, 'tracing.yaml');
      fs.writeFileSync(process.env.TRACING_CONFIG_PATH, 'tracing:\n  enabled: false\n');

      productServer = require('../product-service/dist/index.js').server;
      productUrl = await boundUrl(productServer);
      process.env.PRODUCT_SERVICE_URL = productUrl;
      orderServer = require('../order-service/dist/index.js').server;
      orderUrl = await boundUrl(orderServer);
      process.env.ORDER_SERVICE_URL = orderUrl;
      gatewayServer = require('../api-gateway/dist/index.js').server;
      gatewayUrl = await boundUrl(gatewayServer);
    });

    after(async () => {
      try {
        await Promise.all([gatewayServer, orderServer, productServer].filter(Boolean)
          .map((server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
        if (orderServer) await require('../order-service/dist/db.js').getDbPool()?.end();
      } finally {
        if (tracingDirectory) {
          fs.unlinkSync(path.join(tracingDirectory, 'tracing.yaml'));
          fs.rmdirSync(tracingDirectory);
        }
        for (const key of envKeys) {
          if (previousEnv[key] === undefined) delete process.env[key];
          else process.env[key] = previousEnv[key];
        }
      }
    });

    test('Product Service lists products and serves /health', async () => {
      const healthRes = await fetch(`${productUrl}/health`);
      assert.strictEqual(healthRes.status, 200);
      const health = await healthRes.json();
      assert.strictEqual(health.status, 'UP');

      const prodRes = await fetch(`${productUrl}/products`);
      assert.strictEqual(prodRes.status, 200);
      const prods = await prodRes.json();
      assert.ok(Array.isArray(prods));
      assert.ok(prods.length >= 5);

      const singleRes = await fetch(`${productUrl}/products/prod-1`);
      assert.strictEqual(singleRes.status, 200);
      const item = await singleRes.json();
      assert.strictEqual(item.id, 'prod-1');
    });

    test('Product Service reserves stock correctly', async () => {
      const reserveRes = await fetch(`${productUrl}/products/prod-1/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: 2 }),
      });
      assert.strictEqual(reserveRes.status, 200);
      const resJson = await reserveRes.json();
      assert.strictEqual(resJson.success, true);
    });

    test('Order Service creates order and processes simulated payment', async () => {
      const orderPayload = {
        customerId: 'cust-test-101',
        items: [{ productId: 'prod-2', quantity: 1 }],
        paymentMethod: 'credit_card',
      };

      const res = await fetch(`${orderUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderPayload),
      });

      assert.strictEqual(res.status, 201);
      const order = await res.json();
      assert.strictEqual(order.status, 'CONFIRMED');
      assert.ok(order.payment_reference?.startsWith('pay_'));

      // Retrieve created order
      const getRes = await fetch(`${orderUrl}/orders/${order.id}`);
      assert.strictEqual(getRes.status, 200);
      const fetched = await getRes.json();
      assert.strictEqual(fetched.id, order.id);
    });

    test('Order Service handles payment failure when declined card is used', async () => {
      const failPayload = {
        customerId: 'cust-test-fraud',
        items: [{ productId: 'prod-3', quantity: 1 }],
        paymentMethod: 'credit_card',
        cardNumber: '4002-0000-0000-0000', // Trigger card decline
      };

      const res = await fetch(`${orderUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(failPayload),
      });

      assert.strictEqual(res.status, 402);
      const body = await res.json();
      assert.strictEqual(body.error, 'Payment processing failed');
    });

    test('API Gateway proxies requests and serves metrics', async () => {
      const gwProdRes = await fetch(`${gatewayUrl}/api/products`);
      assert.strictEqual(gwProdRes.status, 200);
      const items = await gwProdRes.json();
      assert.ok(items.length >= 5);

      const metricsRes = await fetch(`${gatewayUrl}/metrics`);
      assert.strictEqual(metricsRes.status, 200);
      const metricsText = await metricsRes.text();
      assert.ok(metricsText.includes('store_http_requests_total'));
    });

    test('API Gateway chaos injection works as expected', async () => {
      // Inject force 500 error
      const injectRes = await fetch(`${gatewayUrl}/api/chaos/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force500: true }),
      });
      assert.strictEqual(injectRes.status, 200);

      // Now request should return 500
      const errorRes = await fetch(`${gatewayUrl}/api/products`);
      assert.strictEqual(errorRes.status, 500);

      // Reset chaos
      const resetRes = await fetch(`${gatewayUrl}/api/chaos/reset`, {
        method: 'POST',
      });
      assert.strictEqual(resetRes.status, 200);

      // Normal request works again
      const okRes = await fetch(`${gatewayUrl}/api/products`);
      assert.strictEqual(okRes.status, 200);
    });

    test('Order Service /ready returns 200 when the database responds, and 503 when it is unavailable', async (t) => {
      // Only the PostgreSQL query is mocked. The deployed YAML, HTTP handler and
      // application readiness probe all run normally.
      const query = t.mock.method(Pool.prototype, 'query', async () => ({ rowCount: 1 }));
      process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/demo_store_test';
      try {
        const ready = await fetch(`${orderUrl}/ready`);
        assert.strictEqual(ready.status, 200);
        const healthy = await ready.json();
        assert.strictEqual(healthy.status, 'READY');
        assert.strictEqual(healthy.checks.database, 'connected');

        query.mock.mockImplementation(async () => { throw new Error('database unreachable'); });
        const unavailable = await fetch(`${orderUrl}/ready`);
        assert.strictEqual(unavailable.status, 503);
        const degraded = await unavailable.json();
        assert.strictEqual(degraded.status, 'DEGRADED');
        assert.strictEqual(degraded.checks.database, 'disconnected');
        assert.deepStrictEqual(query.mock.calls.map((call) => call.arguments), [['SELECT 1'], ['SELECT 1']]);
      } finally {
        delete process.env.DATABASE_URL;
      }
    });
  });
});
