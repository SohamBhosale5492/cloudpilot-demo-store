import { Router, Request, Response } from 'express';
import { handleHealth, handleReady, isHealthEndpointConfigured } from './health';
import { getMetricsRegister, recordHttpRequest } from './metrics';
import { injectChaos, resetChaos, getChaosConfig, applyChaosMiddleware } from './chaos';
import { startSpanFromRequest, injectTraceContext } from './telemetry';
import { Logger } from './logger';

export function createGatewayRoutes(logger: Logger): Router {
  const router = Router();
  const productServiceUrl = process.env.PRODUCT_SERVICE_URL || 'http://localhost:4001';
  const orderServiceUrl = process.env.ORDER_SERVICE_URL || 'http://localhost:4002';

  // Health and Readiness
  router.get('/health', async (req: Request, res: Response) => {
    const isConfigured = isHealthEndpointConfigured('api-gateway', '/health');
    if (!isConfigured) {
      return res.status(404).json({ error: 'Endpoint /health not configured in health-checks.yaml' });
    }
    const health = await handleHealth('api-gateway');
    return res.json(health);
  });

  router.get('/ready', async (req: Request, res: Response) => {
    const isConfigured = isHealthEndpointConfigured('api-gateway', '/ready');
    if (!isConfigured) {
      return res.status(404).json({ error: 'Endpoint /ready not configured in health-checks.yaml' });
    }
    const ready = await handleReady('api-gateway', productServiceUrl, orderServiceUrl);
    return res.status(ready.status === 'READY' ? 200 : 503).json(ready);
  });

  // Prometheus Metrics
  router.get('/metrics', async (req: Request, res: Response) => {
    try {
      const register = getMetricsRegister();
      res.setHeader('Content-Type', register.contentType);
      const metrics = await register.metrics();
      res.send(metrics);
    } catch (err: any) {
      res.status(500).send(err.message);
    }
  });

  // Chaos controls
  router.post('/api/chaos/inject', (req: Request, res: Response) => {
    const updated = injectChaos(req.body || {});
    logger.warn('Chaos configuration injected', updated);
    return res.json({ message: 'Chaos updated', config: updated });
  });

  router.post('/api/chaos/reset', (req: Request, res: Response) => {
    const reset = resetChaos();
    logger.info('Chaos configuration reset');
    return res.json({ message: 'Chaos reset', config: reset });
  });

  router.get('/api/chaos/status', (req: Request, res: Response) => {
    return res.json(getChaosConfig());
  });

  // Product Catalog Gateway Proxy
  router.get('/api/products', async (req: Request, res: Response) => {
    const { span, end } = startSpanFromRequest('api-gateway', 'GET /api/products', req.headers);

    // Chaos evaluation
    const chaos = await applyChaosMiddleware();
    if (chaos.shouldFail500) {
      recordHttpRequest('/api/products', 'GET', 500);
      logger.error('Injected Chaos 500 Fault on /api/products');
      end();
      return res.status(500).json({ error: chaos.errorMsg });
    }

    try {
      const outgoingHeaders: Record<string, string> = { 'Accept': 'application/json' };
      injectTraceContext(outgoingHeaders);

      const upstreamRes = await fetch(`${productServiceUrl}/products`, {
        headers: outgoingHeaders,
      });

      const data = await upstreamRes.json();
      recordHttpRequest('/api/products', 'GET', upstreamRes.status);
      end();
      return res.status(upstreamRes.status).json(data);
    } catch (err: any) {
      recordHttpRequest('/api/products', 'GET', 502);
      logger.error('Gateway failed to forward /api/products', { error: err.message });
      end();
      return res.status(502).json({ error: 'Product service unreachable' });
    }
  });

  router.get('/api/products/:id', async (req: Request, res: Response) => {
    const productId = req.params.id;
    const { span, end } = startSpanFromRequest('api-gateway', `GET /api/products/${productId}`, req.headers);

    const chaos = await applyChaosMiddleware();
    if (chaos.shouldFail500) {
      recordHttpRequest(`/api/products/${productId}`, 'GET', 500);
      logger.error(`Injected Chaos 500 Fault on /api/products/${productId}`);
      end();
      return res.status(500).json({ error: chaos.errorMsg });
    }

    try {
      const outgoingHeaders: Record<string, string> = { 'Accept': 'application/json' };
      injectTraceContext(outgoingHeaders);

      const upstreamRes = await fetch(`${productServiceUrl}/products/${productId}`, {
        headers: outgoingHeaders,
      });

      const data = await upstreamRes.json();
      recordHttpRequest(`/api/products/${productId}`, 'GET', upstreamRes.status);
      end();
      return res.status(upstreamRes.status).json(data);
    } catch (err: any) {
      recordHttpRequest(`/api/products/${productId}`, 'GET', 502);
      logger.error(`Gateway failed to forward /api/products/${productId}`, { error: err.message });
      end();
      return res.status(502).json({ error: 'Product service unreachable' });
    }
  });

  // Order Gateway Proxy
  router.post('/api/orders', async (req: Request, res: Response) => {
    const { span, end } = startSpanFromRequest('api-gateway', 'POST /api/orders', req.headers);

    const chaos = await applyChaosMiddleware();
    if (chaos.shouldFail500) {
      recordHttpRequest('/api/orders', 'POST', 500);
      logger.error('Injected Chaos 500 Fault on /api/orders');
      end();
      return res.status(500).json({ error: chaos.errorMsg });
    }

    try {
      const outgoingHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      injectTraceContext(outgoingHeaders);

      const upstreamRes = await fetch(`${orderServiceUrl}/orders`, {
        method: 'POST',
        headers: outgoingHeaders,
        body: JSON.stringify(req.body),
      });

      const data = await upstreamRes.json();
      recordHttpRequest('/api/orders', 'POST', upstreamRes.status);
      end();
      return res.status(upstreamRes.status).json(data);
    } catch (err: any) {
      recordHttpRequest('/api/orders', 'POST', 502);
      logger.error('Gateway failed to forward /api/orders', { error: err.message });
      end();
      return res.status(502).json({ error: 'Order service unreachable' });
    }
  });

  router.get('/api/orders/:id', async (req: Request, res: Response) => {
    const orderId = req.params.id;
    const { span, end } = startSpanFromRequest('api-gateway', `GET /api/orders/${orderId}`, req.headers);

    try {
      const outgoingHeaders: Record<string, string> = { 'Accept': 'application/json' };
      injectTraceContext(outgoingHeaders);

      const upstreamRes = await fetch(`${orderServiceUrl}/orders/${orderId}`, {
        headers: outgoingHeaders,
      });

      const data = await upstreamRes.json();
      recordHttpRequest(`/api/orders/${orderId}`, 'GET', upstreamRes.status);
      end();
      return res.status(upstreamRes.status).json(data);
    } catch (err: any) {
      recordHttpRequest(`/api/orders/${orderId}`, 'GET', 502);
      logger.error(`Gateway failed to forward /api/orders/${orderId}`, { error: err.message });
      end();
      return res.status(502).json({ error: 'Order service unreachable' });
    }
  });

  router.get('/api/orders', async (req: Request, res: Response) => {
    const { span, end } = startSpanFromRequest('api-gateway', 'GET /api/orders', req.headers);

    try {
      const outgoingHeaders: Record<string, string> = { 'Accept': 'application/json' };
      injectTraceContext(outgoingHeaders);

      const upstreamRes = await fetch(`${orderServiceUrl}/orders`, {
        headers: outgoingHeaders,
      });

      const data = await upstreamRes.json();
      recordHttpRequest('/api/orders', 'GET', upstreamRes.status);
      end();
      return res.status(upstreamRes.status).json(data);
    } catch (err: any) {
      recordHttpRequest('/api/orders', 'GET', 502);
      logger.error('Gateway failed to forward /api/orders', { error: err.message });
      end();
      return res.status(502).json({ error: 'Order service unreachable' });
    }
  });

  return router;
}
