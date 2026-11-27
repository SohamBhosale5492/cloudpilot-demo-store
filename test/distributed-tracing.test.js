const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');

const gatewayTelemetry = require('../api-gateway/dist/telemetry');
const orderTelemetry = require('../order-service/dist/telemetry');
const productTelemetry = require('../product-service/dist/telemetry');
const gatewayLoggerMod = require('../api-gateway/dist/logger');
const orderLoggerMod = require('../order-service/dist/logger');
const productLoggerMod = require('../product-service/dist/logger');
const { createGatewayRoutes } = require('../api-gateway/dist/routes');
const { createOrderRoutes } = require('../order-service/dist/routes');
const { createProductRoutes } = require('../product-service/dist/routes');

function createCapturingLogger(LoggerClass, serviceName, sink) {
  const logger = new LoggerClass(serviceName);
  const originalLog = logger.log.bind(logger);
  logger.log = (level, message, meta = {}) => {
    sink.push(logger.buildEntry(level, message, meta));
    return originalLog(level, message, meta);
  };
  return logger;
}

function buildServiceApp(createRoutes, logger, runWithCorrelationId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const incoming =
      typeof req.headers['x-correlation-id'] === 'string'
        ? req.headers['x-correlation-id']
        : undefined;
    runWithCorrelationId(incoming, () => {
      res.on('finish', () => {
        if (req.path !== '/metrics' && req.path !== '/health' && req.path !== '/ready') {
          const traceCtx = res.locals.traceContext || {};
          logger.info(`${req.method} ${req.path} ${res.statusCode}`, {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            ...(traceCtx.traceId ? { trace_id: traceCtx.traceId } : {}),
            ...(traceCtx.spanId ? { span_id: traceCtx.spanId } : {}),
          });
        }
      });
      next();
    });
  });
  app.use(createRoutes(logger));
  return app;
}

async function listenEphemeral(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function closeAll(servers) {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve()))
        )
    )
  );
}

describe('Demo Store Distributed Tracing & Log Correlation', () => {
  test('baseline config propagates parent-child spans api-gateway -> product-service and correlates logs while order-service remains disabled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-store-dist-baseline-'));
    const tracingPath = path.join(dir, 'tracing.yaml');
    const loggingPath = path.join(dir, 'logging.yaml');
    const prevTracing = process.env.TRACING_CONFIG_PATH;
    const prevLogging = process.env.LOGGING_CONFIG_PATH;
    const prevProductUrl = process.env.PRODUCT_SERVICE_URL;
    const prevOrderUrl = process.env.ORDER_SERVICE_URL;
    const prevLoki = process.env.LOKI_PUSH_URL;
    const prevDb = process.env.DATABASE_URL;

    fs.writeFileSync(
      tracingPath,
      [
        'tracing:',
        '  enabled: true',
        '  propagators: [tracecontext, baggage]',
        '  otlp_endpoint: http://otel-collector:4318/v1/traces',
        'services:',
        '  api-gateway:',
        '    enabled: true',
        '  product-service:',
        '    enabled: true',
        '  order-service:',
        '    enabled: false',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      loggingPath,
      fs.readFileSync(path.resolve(__dirname, '../config/observability/logging.yaml'), 'utf8')
    );

    process.env.TRACING_CONFIG_PATH = tracingPath;
    process.env.LOGGING_CONFIG_PATH = loggingPath;
    delete process.env.LOKI_PUSH_URL;
    delete process.env.DATABASE_URL;

    const exporter = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor(exporter);
    const logs = [];
    const servers = [];

    try {
      gatewayTelemetry.resetTelemetryForTests();
      orderTelemetry.resetTelemetryForTests();
      productTelemetry.resetTelemetryForTests();

      assert.deepEqual(productTelemetry.initTelemetry('product-service', { spanProcessor: processor, forceReinit: true }), { enabled: true });
      assert.deepEqual(orderTelemetry.initTelemetry('order-service', { spanProcessor: processor, forceReinit: true }), { enabled: false });
      assert.deepEqual(gatewayTelemetry.initTelemetry('api-gateway', { spanProcessor: processor, forceReinit: true }), { enabled: true });

      const productSrv = await listenEphemeral(
        buildServiceApp(createProductRoutes, createCapturingLogger(productLoggerMod.Logger, 'product-service', logs), productLoggerMod.runWithCorrelationId)
      );
      servers.push(productSrv.server);
      process.env.PRODUCT_SERVICE_URL = productSrv.url;

      const orderSrv = await listenEphemeral(
        buildServiceApp(createOrderRoutes, createCapturingLogger(orderLoggerMod.Logger, 'order-service', logs), orderLoggerMod.runWithCorrelationId)
      );
      servers.push(orderSrv.server);
      process.env.ORDER_SERVICE_URL = orderSrv.url;

      const gatewaySrv = await listenEphemeral(
        buildServiceApp(createGatewayRoutes, createCapturingLogger(gatewayLoggerMod.Logger, 'api-gateway', logs), gatewayLoggerMod.runWithCorrelationId)
      );
      servers.push(gatewaySrv.server);

      const prodRes = await fetch(`${gatewaySrv.url}/api/products`, {
        headers: { 'x-correlation-id': 'corr-products-1' },
      });
      assert.equal(prodRes.status, 200);

      const spans = exporter.getFinishedSpans();
      const gwSpan = spans.find((s) => s.resource.attributes['service.name'] === 'api-gateway' && s.name === 'GET /api/products');
      const prodSpan = spans.find((s) => s.resource.attributes['service.name'] === 'product-service' && s.name === 'GET /products');
      assert.ok(gwSpan, 'api-gateway span must be exported');
      assert.ok(prodSpan, 'product-service span must be exported');
      assert.equal(prodSpan.spanContext().traceId, gwSpan.spanContext().traceId, 'traceId must propagate from api-gateway to product-service');
      assert.equal(prodSpan.parentSpanId, gwSpan.spanContext().spanId, 'product-service span must be a child of api-gateway span');

      const prodLogs = logs.filter((e) => e.service === 'product-service' && e.message === 'Products listed successfully');
      assert.ok(prodLogs.length >= 1, 'product-service must emit structured business log');
      assert.equal(prodLogs[0].trace_id, gwSpan.spanContext().traceId, 'product-service log must correlate to active trace_id');
      assert.equal(prodLogs[0].span_id, prodSpan.spanContext().spanId, 'product-service log must include active span_id');
      assert.equal(prodLogs[0].correlation_id, 'corr-products-1');

      const gwAccessLog = logs.find((e) => e.service === 'api-gateway' && e.path === '/api/products');
      assert.ok(gwAccessLog, 'api-gateway access log must exist');
      assert.equal(gwAccessLog.trace_id, gwSpan.spanContext().traceId, 'api-gateway access log must include trace_id');
      assert.equal(gwAccessLog.correlation_id, 'corr-products-1');

      // Now call POST /api/orders under baseline: order-service must NOT emit spans
      exporter.reset();
      const orderRes = await fetch(`${gatewaySrv.url}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-correlation-id': 'corr-order-baseline' },
        body: JSON.stringify({ customerId: 'c1', items: [{ productId: 'prod-1', quantity: 1 }] }),
      });
      assert.equal(orderRes.status, 201);
      const orderSpans = exporter.getFinishedSpans();
      assert.equal(
        orderSpans.filter((s) => s.resource.attributes['service.name'] === 'order-service').length,
        0,
        'order-service must not emit spans when disabled in baseline tracing.yaml'
      );
    } finally {
      await closeAll(servers);
      gatewayTelemetry.resetTelemetryForTests();
      orderTelemetry.resetTelemetryForTests();
      productTelemetry.resetTelemetryForTests();
      if (prevTracing === undefined) delete process.env.TRACING_CONFIG_PATH; else process.env.TRACING_CONFIG_PATH = prevTracing;
      if (prevLogging === undefined) delete process.env.LOGGING_CONFIG_PATH; else process.env.LOGGING_CONFIG_PATH = prevLogging;
      if (prevProductUrl === undefined) delete process.env.PRODUCT_SERVICE_URL; else process.env.PRODUCT_SERVICE_URL = prevProductUrl;
      if (prevOrderUrl === undefined) delete process.env.ORDER_SERVICE_URL; else process.env.ORDER_SERVICE_URL = prevOrderUrl;
      if (prevLoki === undefined) delete process.env.LOKI_PUSH_URL; else process.env.LOKI_PUSH_URL = prevLoki;
      if (prevDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevDb;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('remediated config propagates 3-service parent-child spans api-gateway -> order-service -> product-service with correlated logs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-store-dist-remediated-'));
    const tracingPath = path.join(dir, 'tracing.yaml');
    const loggingPath = path.join(dir, 'logging.yaml');
    const prevTracing = process.env.TRACING_CONFIG_PATH;
    const prevLogging = process.env.LOGGING_CONFIG_PATH;
    const prevProductUrl = process.env.PRODUCT_SERVICE_URL;
    const prevOrderUrl = process.env.ORDER_SERVICE_URL;
    const prevLoki = process.env.LOKI_PUSH_URL;
    const prevDb = process.env.DATABASE_URL;

    fs.writeFileSync(
      tracingPath,
      [
        'tracing:',
        '  enabled: true',
        '  propagators: [tracecontext, baggage]',
        '  otlp_endpoint: http://otel-collector:4318/v1/traces',
        'services:',
        '  api-gateway:',
        '    enabled: true',
        '  product-service:',
        '    enabled: true',
        '  order-service:',
        '    enabled: true',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      loggingPath,
      [
        'logging:',
        '  format: json',
        '  service_label: service',
        '  required_fields: [timestamp, level, service, message]',
        'services:',
        '  api-gateway:',
        '    enabled: true',
        '    structured_json: true',
        '    required_fields: [timestamp, level, service, message, correlation_id]',
        '  product-service:',
        '    enabled: true',
        '    structured_json: true',
        '    required_fields: [timestamp, level, service, message, correlation_id]',
        '  order-service:',
        '    enabled: true',
        '    structured_json: true',
        '    required_fields: [timestamp, level, service, message, correlation_id]',
        '',
      ].join('\n')
    );

    process.env.TRACING_CONFIG_PATH = tracingPath;
    process.env.LOGGING_CONFIG_PATH = loggingPath;
    delete process.env.LOKI_PUSH_URL;
    delete process.env.DATABASE_URL;

    const exporter = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor(exporter);
    const logs = [];
    const servers = [];

    try {
      gatewayTelemetry.resetTelemetryForTests();
      orderTelemetry.resetTelemetryForTests();
      productTelemetry.resetTelemetryForTests();

      assert.deepEqual(productTelemetry.initTelemetry('product-service', { spanProcessor: processor, forceReinit: true }), { enabled: true });
      assert.deepEqual(orderTelemetry.initTelemetry('order-service', { spanProcessor: processor, forceReinit: true }), { enabled: true });
      assert.deepEqual(gatewayTelemetry.initTelemetry('api-gateway', { spanProcessor: processor, forceReinit: true }), { enabled: true });

      const productSrv = await listenEphemeral(
        buildServiceApp(createProductRoutes, createCapturingLogger(productLoggerMod.Logger, 'product-service', logs), productLoggerMod.runWithCorrelationId)
      );
      servers.push(productSrv.server);
      process.env.PRODUCT_SERVICE_URL = productSrv.url;

      const orderSrv = await listenEphemeral(
        buildServiceApp(createOrderRoutes, createCapturingLogger(orderLoggerMod.Logger, 'order-service', logs), orderLoggerMod.runWithCorrelationId)
      );
      servers.push(orderSrv.server);
      process.env.ORDER_SERVICE_URL = orderSrv.url;

      const gatewaySrv = await listenEphemeral(
        buildServiceApp(createGatewayRoutes, createCapturingLogger(gatewayLoggerMod.Logger, 'api-gateway', logs), gatewayLoggerMod.runWithCorrelationId)
      );
      servers.push(gatewaySrv.server);

      const orderRes = await fetch(`${gatewaySrv.url}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-correlation-id': 'corr-order-3hop' },
        body: JSON.stringify({ customerId: 'cust-trace', items: [{ productId: 'prod-1', quantity: 1 }] }),
      });
      assert.equal(orderRes.status, 201);

      const spans = exporter.getFinishedSpans();
      const gwSpan = spans.find((s) => s.resource.attributes['service.name'] === 'api-gateway' && s.name === 'POST /api/orders');
      const orderSpan = spans.find((s) => s.resource.attributes['service.name'] === 'order-service' && s.name === 'POST /orders');
      const reserveSpan = spans.find((s) => s.resource.attributes['service.name'] === 'product-service' && s.name === 'POST /products/prod-1/reserve');

      assert.ok(gwSpan, 'api-gateway span must exist');
      assert.ok(orderSpan, 'order-service span must exist when remediated');
      assert.ok(reserveSpan, 'product-service reserve span must exist');

      const traceId = gwSpan.spanContext().traceId;
      assert.equal(orderSpan.spanContext().traceId, traceId, 'order-service must share api-gateway traceId');
      assert.equal(orderSpan.parentSpanId, gwSpan.spanContext().spanId, 'order-service span must be child of api-gateway span');
      assert.equal(reserveSpan.spanContext().traceId, traceId, 'product-service must share api-gateway traceId');
      assert.equal(reserveSpan.parentSpanId, orderSpan.spanContext().spanId, 'product-service span must be child of order-service span');

      const orderLog = logs.find((e) => e.service === 'order-service' && e.message === 'Order successfully placed and confirmed');
      const productLog = logs.find((e) => e.service === 'product-service' && e.message === 'Product stock reserved');
      const gatewayLog = logs.find((e) => e.service === 'api-gateway' && e.path === '/api/orders');

      assert.ok(orderLog && productLog && gatewayLog, 'all three services must emit correlated logs');
      assert.equal(orderLog.trace_id, traceId);
      assert.equal(orderLog.span_id, orderSpan.spanContext().spanId);
      assert.equal(orderLog.correlation_id, 'corr-order-3hop');
      assert.equal(productLog.trace_id, traceId);
      assert.equal(productLog.correlation_id, 'corr-order-3hop');
      assert.equal(gatewayLog.trace_id, traceId);
      assert.equal(gatewayLog.correlation_id, 'corr-order-3hop');
    } finally {
      await closeAll(servers);
      gatewayTelemetry.resetTelemetryForTests();
      orderTelemetry.resetTelemetryForTests();
      productTelemetry.resetTelemetryForTests();
      if (prevTracing === undefined) delete process.env.TRACING_CONFIG_PATH; else process.env.TRACING_CONFIG_PATH = prevTracing;
      if (prevLogging === undefined) delete process.env.LOGGING_CONFIG_PATH; else process.env.LOGGING_CONFIG_PATH = prevLogging;
      if (prevProductUrl === undefined) delete process.env.PRODUCT_SERVICE_URL; else process.env.PRODUCT_SERVICE_URL = prevProductUrl;
      if (prevOrderUrl === undefined) delete process.env.ORDER_SERVICE_URL; else process.env.ORDER_SERVICE_URL = prevOrderUrl;
      if (prevLoki === undefined) delete process.env.LOKI_PUSH_URL; else process.env.LOKI_PUSH_URL = prevLoki;
      if (prevDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevDb;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
