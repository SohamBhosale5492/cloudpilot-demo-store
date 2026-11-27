const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  Logger,
  loadLoggingConfig,
  runWithCorrelationId,
} = require('../order-service/dist/logger');

test('Order Service honors both baseline and remediated logging configuration', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudpilot-logging-contract-'));
  const file = path.join(directory, 'logging.yaml');
  const previous = process.env.LOGGING_CONFIG_PATH;
  process.env.LOGGING_CONFIG_PATH = file;
  try {
    // Baseline: correlation_id omitted
    fs.writeFileSync(
      file,
      [
        'logging:',
        '  format: json',
        '  service_label: service',
        '  required_fields:',
        '    - timestamp',
        '    - level',
        '    - service',
        '    - message',
        'services:',
        '  order-service:',
        '    enabled: true',
        '    structured_json: true',
        '    required_fields:',
        '      - timestamp',
        '      - level',
        '      - service',
        '      - message',
        '',
      ].join('\n')
    );

    const baselineCfg = loadLoggingConfig('order-service');
    assert.equal(baselineCfg.enabled, true);
    assert.equal(baselineCfg.structuredJson, true);
    assert.equal(baselineCfg.serviceLabel, 'service');
    assert.deepEqual(baselineCfg.requiredFields, ['timestamp', 'level', 'service', 'message']);

    const logger = new Logger('order-service');
    const baselineEntry = runWithCorrelationId('corr-baseline-1', () =>
      logger.buildEntry('info', 'Processing order placement', { orderId: 'ord-1' })
    );
    assert.equal(baselineEntry.service, 'order-service');
    assert.equal(baselineEntry.level, 'info');
    assert.equal(baselineEntry.message, 'Processing order placement');
    assert.equal('correlation_id' in baselineEntry, false);

    // Remediated: correlation_id declared
    fs.writeFileSync(
      file,
      [
        'logging:',
        '  format: json',
        '  service_label: service',
        '  required_fields:',
        '    - timestamp',
        '    - level',
        '    - service',
        '    - message',
        'services:',
        '  order-service:',
        '    enabled: true',
        '    structured_json: true',
        '    required_fields:',
        '      - timestamp',
        '      - level',
        '      - service',
        '      - message',
        '      - correlation_id',
        '',
      ].join('\n')
    );

    const remediatedCfg = loadLoggingConfig('order-service');
    assert.equal(remediatedCfg.requiredFields.includes('correlation_id'), true);

    const remediatedEntry = runWithCorrelationId('corr-remediated-42', () =>
      logger.buildEntry('info', 'Order successfully placed and confirmed', { orderId: 'ord-2' })
    );
    assert.equal(remediatedEntry.correlation_id, 'corr-remediated-42');
    assert.equal(remediatedEntry.service, 'order-service');
  } finally {
    if (previous === undefined) delete process.env.LOGGING_CONFIG_PATH;
    else process.env.LOGGING_CONFIG_PATH = previous;
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});
