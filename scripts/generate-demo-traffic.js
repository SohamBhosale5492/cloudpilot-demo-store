#!/usr/bin/env node

// Bounded, real requests for the local mentor demonstration. One successful
// order is persisted per run; this script never clears application data.
const base = 'http://127.0.0.1:4000';
const prometheus = 'http://127.0.0.1:9090';

async function request(path, options) {
  const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response;
}

async function sample(query) {
  const url = new URL('/api/v1/query', prometheus);
  url.searchParams.set('query', query);
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Prometheus returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.status !== 'success') throw new Error('Prometheus query failed');
  return body.data.result;
}

async function waitForScrape() {
  const start = Date.now();
  const first = (await sample('timestamp(up{job="order-service"})'))[0]?.value?.[1];
  if (!first) throw new Error('Order Service scrape target is unavailable');
  while (Date.now() - start < 20_000) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const current = (await sample('timestamp(up{job="order-service"})'))[0]?.value?.[1];
    if (current && Number(current) > Number(first)) return;
  }
  throw new Error('No new Order Service scrape arrived within 20 seconds');
}

async function main() {
  const health = await request('/api/products');
  const products = await health.json();
  if (!Array.isArray(products) || !products.some((item) => item.id === 'prod-1'))
    throw new Error('Demo product prod-1 is unavailable');
  await request('/api/products/prod-1');
  await waitForScrape();

  // A real purchase exercises the success path and leaves one labeled demo
  // order in the disposable Demo Store database.
  const response = await request('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerId: `cloudpilot-demo-${Date.now()}`,
      items: [{ productId: 'prod-1', quantity: 1 }],
      paymentMethod: 'credit_card'
    })
  });
  if (response.status !== 201) throw new Error(`Order returned HTTP ${response.status}`);
  const order = await response.json();
  if (order.status !== 'CONFIRMED') throw new Error('Order was not confirmed');
  await request('/api/products');
  await request('/api/products/prod-1');
  await waitForScrape();

  // If the container started fresh, a second order moves the labeled counter from 1 -> 2
  // so Prometheus increase(...[300s]) reports >= 1 immediately in the scan window.
  const initialOrderInc = (await sample('increase(store_http_requests_total{service="order-service",route="/orders",method="POST"}[300s])'))
    .reduce((sum, result) => sum + Number(result.value[1]), 0);
  if (initialOrderInc < 1) {
    const secondResponse = await request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: `cloudpilot-demo-${Date.now()}-b`,
        items: [{ productId: 'prod-1', quantity: 1 }],
        paymentMethod: 'credit_card'
      })
    });
    if (secondResponse.status !== 201) throw new Error(`Second order returned HTTP ${secondResponse.status}`);
    await waitForScrape();
  }

  const selectors = [
    'store_http_requests_total{service="api-gateway",route="/api/products",method="GET"}',
    'store_product_views_total{service="product-service",route="/products",method="GET"}',
    'store_http_requests_total{service="order-service",route="/orders",method="POST"}',
    'store_orders_placed_total{service="order-service"}'
  ];
  for (const selector of selectors) {
    const results = await sample(`increase(${selector}[300s])`);
    const total = results.reduce((sum, result) => sum + Number(result.value[1]), 0);
    console.log(`${selector}: ${total.toFixed(2)} requests in the five-minute window`);
  }
  console.log(`Confirmed one real demo order: ${order.id}`);
  console.log('CloudPilot scan can now inspect the fresh Prometheus evidence.');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
