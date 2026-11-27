const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('yaml');
const { validateOrderPlacementMetric } = require('./order-placement-metric-contract');

const declaration = {
  name: 'store_orders_placed_total', service: 'order-service', route: '/orders', method: 'POST',
  labels: { service: 'order-service', route: '/orders', method: 'POST' },
};

test('configuration contract accepts missing baseline and valid proposed declaration', () => {
  assert.equal(validateOrderPlacementMetric([]), false);
  assert.equal(validateOrderPlacementMetric([declaration]), true);
  assert.throws(() => validateOrderPlacementMetric([{ ...declaration, service: 'api-gateway' }]));
  assert.throws(() => validateOrderPlacementMetric([{ ...declaration, labels: { service: 'order-service' } }]));
  assert.throws(() => validateOrderPlacementMetric([declaration, declaration]));
});

test('isolated configured fixture registers and emits the successful order counter', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudpilot-order-metric-'));
  try {
    const configPath = path.join(directory, 'metrics.yaml');
    fs.writeFileSync(configPath, yaml.stringify({ metrics: [declaration] }));
    const modulePath = path.resolve(__dirname, '../order-service/dist/metrics.js');
    const code = 'const m=require(process.argv[1]); m.initMetrics("order-service"); m.recordOrderPlaced("success"); m.getMetricsRegister().metrics().then(v=>process.stdout.write(v));';
    const result = spawnSync(process.execPath, ['-e', code, modulePath], {
      env: { ...process.env, METRICS_CONFIG_PATH: configPath }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /store_orders_placed_total\{[^}]*service="order-service"[^}]*route="\/orders"[^}]*method="POST"[^}]*status="success"[^}]*\}\s+1\b/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
