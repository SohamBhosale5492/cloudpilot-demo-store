# cloudpilot-demo-store

A realistic Node.js/TypeScript microservices e-commerce application designed as a **CloudPilot inspection target**. It demonstrates five observability signals (metrics, health, alerts, traces, logs) with **four intentional gaps** that CloudPilot can detect and remediate.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Client                                                      │
│    │                                                         │
│    ▼                                                         │
│  API Gateway :4000  ──────────────── Prometheus :9090        │
│    │   │                                                     │
│    │   └──► Product Service :4001                            │
│    │              │                  Jaeger :16686           │
│    └──► Order Service :4002  ──────► (via OTel Collector)   │
│               │                                              │
│               ▼                      Loki :3100              │
│          PostgreSQL :5439                                    │
│                                      OTel Collector :4318    │
└─────────────────────────────────────────────────────────────┘
```

| Service | Host Port | Purpose |
|---------|-----------|---------|
| API Gateway | 4000 | Proxies all external requests, chaos injection |
| Product Service | 4001 | Product catalog, stock reservation |
| Order Service | 4002 | Order placement, payment processing |
| PostgreSQL | 5439 | Products & orders persistence |
| OTel Collector | 4318 | Receives OTLP traces/metrics, exports to Jaeger |
| Prometheus | 9090 | Scrapes /metrics endpoints, loads alert rules |
| Jaeger | 16686 | Distributed trace storage and UI |
| Loki | 3100 | Structured JSON log ingestion |

## Quick Start

```bash
# Start the full observability stack
docker compose up -d --build

# Verify everything is healthy
node scripts/verify.js

# Run all unit + integration tests (no Docker required)
npm test
```

## API Endpoints

### API Gateway (port 4000)

```bash
# Products
GET  /api/products               # List all 5 products
GET  /api/products/:id           # Get product by ID

# Orders
POST /api/orders                 # Create order (triggers stock reservation + payment)
GET  /api/orders/:id             # Get order by ID
GET  /api/orders                 # List recent orders

# Observability
GET  /health                     # Health check
GET  /ready                      # Readiness (checks downstream services)
GET  /metrics                    # Prometheus metrics

# Chaos Engineering
POST /api/chaos/inject           # Inject failures: { latencyMs, errorRate, force500 }
POST /api/chaos/reset            # Remove all chaos
GET  /api/chaos/status           # Current chaos config
```

### Product Service (port 4001)

```bash
GET  /products                   # List all products
GET  /products/:id               # Get single product
POST /products/:id/reserve       # Reserve stock: { quantity }
GET  /health                     # Health check
GET  /ready                      # Readiness (checks DB)
GET  /metrics                    # Prometheus metrics
```

### Order Service (port 4002)

```bash
POST /orders                     # Create order with payment processing
GET  /orders/:id                 # Get order
GET  /orders                     # List orders (last 50)
GET  /health                     # Health check
GET  /ready                      # ⚠ Returns 404 NOT_CONFIGURED (intentional gap)
GET  /metrics                    # Prometheus metrics
POST /chaos/payment              # Toggle payment chaos: { active: true/false }
```

## Example API Calls

### List products
```bash
curl http://localhost:4000/api/products
```

### Place a valid order
```bash
curl -X POST http://localhost:4000/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "cust-123",
    "items": [{"productId": "prod-1", "quantity": 1}],
    "paymentMethod": "credit_card"
  }'
```

### Trigger a payment failure (declined card)
```bash
curl -X POST http://localhost:4000/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "cust-fraud",
    "items": [{"productId": "prod-2", "quantity": 1}],
    "paymentMethod": "credit_card",
    "cardNumber": "4002-0000-0000-0001"
  }'
```

### Inject chaos (force 500 errors on gateway)
```bash
curl -X POST http://localhost:4000/api/chaos/inject \
  -H "Content-Type: application/json" \
  -d '{"force500": true}'

# Reset
curl -X POST http://localhost:4000/api/chaos/reset
```

### Inject latency
```bash
curl -X POST http://localhost:4000/api/chaos/inject \
  -H "Content-Type: application/json" \
  -d '{"latencyMs": 2000, "errorRate": 0.3}'
```

### Payment chaos on Order Service
```bash
curl -X POST http://localhost:4002/chaos/payment \
  -H "Content-Type: application/json" \
  -d '{"active": true}'
```

## Observability

### Prometheus Metrics
- `store_http_requests_total` — API Gateway HTTP requests labelled by route, method, status_code
- `store_product_views_total` — Product Service page views labelled by product_id
- All standard `store_nodejs_*` process metrics (memory, GC, eventloop)

### Distributed Traces (Jaeger)
- API Gateway → Product Service: full request chain traced
- API Gateway → Order Service → Product Service: multi-hop trace with W3C traceparent propagation
- View traces: http://localhost:16686

### Structured Logs (Loki)
- All services emit JSON logs to stdout and push to Loki
- Fields: `timestamp`, `level`, `service`, `message`, `trace_id`, `span_id`
- Query in Loki: `{service="api-gateway"}`

### Alert Rules (Prometheus)
- `store_gateway_high_error_rate` — 5xx rate > 5% for 1 minute
- `store_product_service_down` — `up{job="product-service"} == 0` for 30s
- View: http://localhost:9090/alerts

## Intentional Observability Gaps (for CloudPilot)

These gaps are **deliberately introduced** so CloudPilot can detect and remediate them:

| Gap # | Signal | Description | Evidence |
|-------|--------|-------------|----------|
| 1 | **Metric** | `store_orders_placed_total` metric for Order Service is absent from `config/observability/metrics.yaml` | Order Service never registers the counter; Prometheus has no order placement data |
| 2 | **Health** | `order-service /ready` endpoint is absent from `config/observability/health-checks.yaml` | `GET /ready` on Order Service returns `HTTP 404 NOT_CONFIGURED` |
| 3 | **Alert** | Order Service heartbeat alert (`up{job="order-service"} == 0`) is absent from `config/observability/alert-rules.yaml` | Prometheus /api/v1/rules shows no order-service alert rule |
| 4 | **Trace** | Order Service tracing is set to `enabled: false` in `config/observability/tracing.yaml` | Jaeger shows no spans from `order-service`; gateway→order trace chain is broken |

> **Note:** Log remediation is explicitly unsupported by CloudPilot and will not produce a false-positive resolution.

## Configuration Files

All observability configuration lives under `config/observability/`:

| File | Purpose |
|------|---------|
| `metrics.yaml` | Metric name, service, route, and label declarations |
| `health-checks.yaml` | Per-service health/readiness endpoint declarations |
| `alert-rules.yaml` | Prometheus alerting rules (Prometheus-native format) |
| `tracing.yaml` | Per-service OpenTelemetry tracing enable/disable |

Services read these files at startup via environment variables:
- `METRICS_CONFIG_PATH`
- `HEALTH_CONFIG_PATH`
- `TRACING_CONFIG_PATH`

## Verification

```bash
# Config gap verification (no Docker needed)
node scripts/verify.js

# Full live endpoint verification (requires docker compose up)
node scripts/live-test.js

# Unit + integration tests
npm test
```

Expected test output: **11 tests, 11 pass, 0 fail**

## Seed Data

PostgreSQL is pre-seeded with 5 products:

| ID | Name | Price | Category |
|----|------|-------|----------|
| prod-1 | UltraBook Pro 15 | $1499.99 | Computers |
| prod-2 | Studio Sound ANC Headphones | $299.99 | Audio |
| prod-3 | ProTactile Mechanical Keyboard | $149.99 | Peripherals |
| prod-4 | UltraView 4K IPS Monitor | $499.99 | Displays |
| prod-5 | ThunderDock Pro Hub | $199.99 | Accessories |

## Stopping / Cleanup

```bash
# Stop all containers (preserve volumes/data)
docker compose down

# Stop and remove all data
docker compose down -v
```

## Important Constraints

- Do **not** implement CloudPilot functionality inside this repository
- This project is completely independent of `CloudPilot_Phase00/CloudPilot`
- No credentials or secrets are stored here
- PostgreSQL host port is `5439` (not `5432`) to avoid collisions with existing CloudPilot containers
