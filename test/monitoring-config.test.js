const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Blackbox readiness scrape targets the real Order Service endpoint', () => {
  const prometheus = read('prometheus/prometheus.yml');
  const blackbox = read('blackbox/blackbox.yml');

  assert.match(prometheus, /job_name:\s*["']?blackbox-exporter/);
  assert.match(prometheus, /targets:\s*\[["']blackbox-exporter:9115["']\]/);
  assert.match(prometheus, /job_name:\s*["']?order-service-readiness/);
  assert.match(prometheus, /module:\s*\[http_2xx\]/);
  assert.match(prometheus, /http:\/\/order-service:4002\/ready/);
  assert.match(prometheus, /target_label:\s*__param_target/);
  assert.match(prometheus, /replacement:\s*blackbox-exporter:9115/);
  assert.match(blackbox, /http_2xx:/);
  assert.match(blackbox, /prober:\s*http/);
});

test('Prometheus loads the remediated Order Service heartbeat rule file', () => {
  const prometheus = read('prometheus/prometheus.yml');
  const compose = read('docker-compose.yml');
  const alerts = read('config/observability/alert-rules.yaml');

  assert.match(prometheus, /rule_files:\s*\n\s*- \/etc\/prometheus\/rules\/alert-rules\.yaml/);
  assert.match(compose,
    /\.\/config\/observability\/alert-rules\.yaml:\/etc\/prometheus\/rules\/alert-rules\.yaml:ro/);
  assert.match(alerts, /alert:\s*store_order_service_heartbeat_alert/);
  assert.match(alerts, /expr:\s*up\{job=["']order-service["']\}\s*==\s*0/);
});

test('Grafana dashboard uses real metrics and preserves unhealthy/no-data semantics', () => {
  const dashboard = JSON.parse(read('grafana/dashboards/cloudpilot-demo-store.json'));
  const byTitle = new Map(dashboard.panels.map((panel) => [panel.title, panel]));

  const readiness = byTitle.get('Order Service readiness');
  assert.ok(readiness, 'readiness panel exists');
  assert.equal(readiness.targets[0].expr, 'probe_success{job="order-service-readiness"}');
  assert.match(readiness.description, /No data means the probe has not reported/);
  const mappings = readiness.fieldConfig.defaults.mappings[0].options;
  assert.equal(mappings['0'].text, 'UNHEALTHY');
  assert.equal(mappings['0'].color, 'red');
  assert.equal(mappings['1'].text, 'HEALTHY');
  assert.equal(mappings['1'].color, 'green');

  assert.equal(byTitle.get('Readiness HTTP status').targets[0].expr,
    'probe_http_status_code{job="order-service-readiness"}');
  assert.equal(byTitle.get('Readiness probe duration').targets[0].expr,
    'probe_duration_seconds{job="order-service-readiness"}');
  assert.match(byTitle.get('Order POST operations').targets[0].expr,
    /store_http_requests_total\{service="order-service",route="\/orders",method="POST"\}/);
  assert.match(byTitle.get('Order POST operations').description,
    /not the intentionally absent successful-order counter/);
});

test('Grafana services are pinned, loopback-bound, and use persistent storage', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /image:\s*prom\/blackbox-exporter:v0\.29\.1/);
  assert.match(compose, /image:\s*grafana\/grafana:13\.3\.1/);
  assert.match(compose, /127\.0\.0\.1:3002:3000/);
  assert.match(compose, /grafana_data:\s*\/var\/lib\/grafana/);
  assert.doesNotMatch(compose, /blackbox-exporter:[\s\S]{0,300}?ports:/);
});
