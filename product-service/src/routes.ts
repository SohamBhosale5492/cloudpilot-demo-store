import { Router, Request, Response } from 'express';
import { getAllProducts, getProductById, reserveProductStock } from './db';
import { handleHealth, handleReady, isHealthEndpointConfigured } from './health';
import { getMetricsRegister, recordProductView } from './metrics';
import { startSpanFromRequest } from './telemetry';
import { Logger } from './logger';

export function createProductRoutes(logger: Logger): Router {
  const router = Router();

  // Health and Readiness
  router.get('/health', async (req: Request, res: Response) => {
    const isConfigured = isHealthEndpointConfigured('product-service', '/health');
    if (!isConfigured) {
      return res.status(404).json({ error: 'Endpoint /health not configured in health-checks.yaml' });
    }
    const health = await handleHealth('product-service');
    return res.json(health);
  });

  router.get('/ready', async (req: Request, res: Response) => {
    const isConfigured = isHealthEndpointConfigured('product-service', '/ready');
    if (!isConfigured) {
      return res.status(404).json({ error: 'Endpoint /ready not configured in health-checks.yaml' });
    }
    const ready = await handleReady('product-service');
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

  // Product Catalog
  router.get('/products', async (req: Request, res: Response) => {
    const { span, end } = startSpanFromRequest('product-service', 'GET /products', req.headers);
    try {
      const products = await getAllProducts();
      recordProductView('/products', 'GET', 'all');
      logger.info('Products listed successfully', { count: products.length });
      end();
      return res.json(products);
    } catch (err: any) {
      logger.error('Failed to list products', { error: err.message });
      end();
      return res.status(500).json({ error: 'Failed to list products' });
    }
  });

  router.get('/products/:id', async (req: Request, res: Response) => {
    const productId = req.params.id;
    const { span, end } = startSpanFromRequest('product-service', `GET /products/${productId}`, req.headers);
    try {
      const product = await getProductById(productId);
      if (!product) {
        logger.warn('Product not found', { productId });
        end();
        return res.status(404).json({ error: `Product ${productId} not found` });
      }

      recordProductView('/products', 'GET', productId);
      logger.info('Product retrieved', { productId, name: product.name, price: product.price });
      end();
      return res.json(product);
    } catch (err: any) {
      logger.error('Error fetching product', { productId, error: err.message });
      end();
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/products/:id/reserve', async (req: Request, res: Response) => {
    const productId = req.params.id;
    const quantity = Number(req.body?.quantity || 1);
    const { span, end } = startSpanFromRequest('product-service', `POST /products/${productId}/reserve`, req.headers);

    try {
      const outcome = await reserveProductStock(productId, quantity);
      if (!outcome.success) {
        logger.warn('Insufficient stock for reservation', { productId, requested: quantity });
        end();
        return res.status(409).json({ error: 'Insufficient stock or product unavailable', remainingStock: outcome.remainingStock });
      }

      logger.info('Product stock reserved', { productId, quantity, remainingStock: outcome.remainingStock });
      end();
      return res.json({ success: true, productId, reserved: quantity, remainingStock: outcome.remainingStock });
    } catch (err: any) {
      logger.error('Failed to reserve stock', { productId, error: err.message });
      end();
      return res.status(500).json({ error: 'Failed to reserve stock' });
    }
  });

  return router;
}
