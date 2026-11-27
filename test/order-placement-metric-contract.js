const assert = require('node:assert/strict');

const EXPECTED = {
  name: 'store_orders_placed_total', service: 'order-service', route: '/orders', method: 'POST',
  labels: { service: 'order-service', route: '/orders', method: 'POST' },
};

function validateOrderPlacementMetric(metrics) {
  assert.ok(Array.isArray(metrics), 'metrics must be a sequence');
  const entries = metrics.filter((metric) => metric?.name === EXPECTED.name);
  assert.ok(entries.length <= 1, 'order placement metric must not be duplicated');
  if (entries.length) assert.deepStrictEqual(entries[0], EXPECTED, 'order placement metric declaration must match instrumentation');
  return entries.length === 1;
}

module.exports = { validateOrderPlacementMetric };
