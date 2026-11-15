const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
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

    test('health-checks.yaml has intentional gap: order-service /ready is missing', () => {
      const healthPath = path.join(rootDir, 'config/observability/health-checks.yaml');
      assert.ok(fs.existsSync(healthPath), 'health-checks.yaml should exist');
      const content = yaml.parse(fs.readFileSync(healthPath, 'utf8'));
      const checks = content.health_checks || [];
      const orderReady = checks.find((c) => c.service === 'order-service' && c.endpoint === '/ready');
      assert.strictEqual(orderReady, undefined, 'order-service /ready must be absent as intentional gap');
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
    let productApp, orderApp, gatewayApp;
    let productServer, orderServer, gatewayServer;

    before(async () => {
      // Import compiled modules
      const prodModule = require('../product-service/dist/index.js');
      const orderModule = require('../order-service/dist/index.js');
      const gwModule = require('../api-gateway/dist/index.js');

      productApp = prodModule.app;
      productServer = prodModule.server;
      orderApp = orderModule.app;
      orderServer = orderModule.server;
      gatewayApp = gwModule.app;
      gatewayServer = gwModule.server;
    });

    after(() => {
      if (productServer && productServer.close) productServer.close();
      if (orderServer && orderServer.close) orderServer.close();
      if (gatewayServer && gatewayServer.close) gatewayServer.close();
    });

    test('Product Service lists products and serves /health', async () => {
      const healthRes = await fetch('http://127.0.0.1:4001/health');
      assert.strictEqual(healthRes.status, 200);
      const health = await healthRes.json();
      assert.strictEqual(health.status, 'UP');

      const prodRes = await fetch('http://127.0.0.1:4001/products');
      assert.strictEqual(prodRes.status, 200);
      const prods = await prodRes.json();
      assert.ok(Array.isArray(prods));
      assert.ok(prods.length >= 5);

      const singleRes = await fetch('http://127.0.0.1:4001/products/prod-1');
      assert.strictEqual(singleRes.status, 200);
      const item = await singleRes.json();
      assert.strictEqual(item.id, 'prod-1');
    });

    test('Product Service reserves stock correctly', async () => {
      const reserveRes = await fetch('http://127.0.0.1:4001/products/prod-1/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: 2 }),
      });
      assert.strictEqual(reserveRes.status, 200);
      const resJson = await reserveRes.json();
      assert.strictEqual(resJson.success, true);
    });

    test('Order Service /ready returns 404 (intentional gap verified)', async () => {
      const readyRes = await fetch('http://127.0.0.1:4002/ready');
      assert.strictEqual(readyRes.status, 404);
      const body = await readyRes.json();
      assert.strictEqual(body.status, 'NOT_CONFIGURED');
    });

    test('Order Service creates order and processes simulated payment', async () => {
      const orderPayload = {
        customerId: 'cust-test-101',
        items: [{ productId: 'prod-2', quantity: 1 }],
        paymentMethod: 'credit_card',
      };

      const res = await fetch('http://127.0.0.1:4002/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderPayload),
      });

      assert.strictEqual(res.status, 201);
      const order = await res.json();
      assert.strictEqual(order.status, 'CONFIRMED');
      assert.ok(order.payment_reference?.startsWith('pay_'));

      // Retrieve created order
      const getRes = await fetch(`http://127.0.0.1:4002/orders/${order.id}`);
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

      const res = await fetch('http://127.0.0.1:4002/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(failPayload),
      });

      assert.strictEqual(res.status, 402);
      const body = await res.json();
      assert.strictEqual(body.error, 'Payment processing failed');
    });

    test('API Gateway proxies requests and serves metrics', async () => {
      const gwProdRes = await fetch('http://127.0.0.1:4000/api/products');
      assert.strictEqual(gwProdRes.status, 200);
      const items = await gwProdRes.json();
      assert.ok(items.length >= 5);

      const metricsRes = await fetch('http://127.0.0.1:4000/metrics');
      assert.strictEqual(metricsRes.status, 200);
      const metricsText = await metricsRes.text();
      assert.ok(metricsText.includes('store_http_requests_total'));
    });

    test('API Gateway chaos injection works as expected', async () => {
      // Inject force 500 error
      const injectRes = await fetch('http://127.0.0.1:4000/api/chaos/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force500: true }),
      });
      assert.strictEqual(injectRes.status, 200);

      // Now request should return 500
      const errorRes = await fetch('http://127.0.0.1:4000/api/products');
      assert.strictEqual(errorRes.status, 500);

      // Reset chaos
      const resetRes = await fetch('http://127.0.0.1:4000/api/chaos/reset', {
        method: 'POST',
      });
      assert.strictEqual(resetRes.status, 200);

      // Normal request works again
      const okRes = await fetch('http://127.0.0.1:4000/api/products');
      assert.strictEqual(okRes.status, 200);
    });
  });
});
