const http = require('node:http');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    };
    const u = new URL(url);
    opts.hostname = u.hostname;
    opts.port = u.port;
    opts.path = u.pathname;
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  // 1. List products
  const prods = await get('http://127.0.0.1:4000/api/products');
  const products = JSON.parse(prods.body);
  console.log('Products count:', products.length, '| First:', products[0].name, 'at $' + products[0].price);

  // 2. Place a valid order
  const order = await post('http://127.0.0.1:4000/api/orders', {
    customerId: 'demo-cust-1',
    items: [{ productId: 'prod-4', quantity: 1 }],
    paymentMethod: 'credit_card',
  });
  const orderData = JSON.parse(order.body);
  console.log('Order placed:', orderData.id, 'status=' + orderData.status, 'payRef=' + orderData.payment_reference);

  // 3. Trigger payment failure
  const failed = await post('http://127.0.0.1:4000/api/orders', {
    customerId: 'fraud-cust',
    items: [{ productId: 'prod-5', quantity: 1 }],
    paymentMethod: 'credit_card',
    cardNumber: '4002-0000',
  });
  console.log('Declined order status:', failed.status, JSON.parse(failed.body).error);

  // 4. Check gateway metrics
  const metrics = await get('http://127.0.0.1:4000/metrics');
  const metricLines = metrics.body.split('\n').filter(l => l.includes('store_http_requests_total') && !l.startsWith('#'));
  console.log('\nGateway store_http_requests_total metric lines:');
  metricLines.forEach(l => console.log(' ', l));

  // 5. Check Prometheus alert rules
  const rulesResp = await get('http://127.0.0.1:9090/api/v1/rules');
  const rules = JSON.parse(rulesResp.body);
  const ruleNames = (rules.data.groups || []).flatMap(g => g.rules || []).map(r => r.name || r.alert).filter(Boolean);
  console.log('\nPrometheus alert rules loaded:', ruleNames.join(', '));
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
