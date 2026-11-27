const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTelemetryConfig } = require('../order-service/dist/telemetry');

test('Order Service honors both baseline and remediated tracing configuration', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudpilot-tracing-contract-'));
  const file = path.join(directory, 'tracing.yaml');
  const previous = process.env.TRACING_CONFIG_PATH;
  process.env.TRACING_CONFIG_PATH = file;
  try {
    for (const enabled of [false, true]) {
      fs.writeFileSync(file, `tracing:\n  enabled: true\n  otlp_endpoint: http://collector:4318/v1/traces\nservices:\n  order-service:\n    enabled: ${enabled}\n`);
      assert.deepEqual(loadTelemetryConfig('order-service'), {
        enabled, serviceName: 'order-service', otlpEndpoint: 'http://collector:4318/v1/traces'
      });
    }
  } finally {
    if (previous === undefined) delete process.env.TRACING_CONFIG_PATH;
    else process.env.TRACING_CONFIG_PATH = previous;
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});
