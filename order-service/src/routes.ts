import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import { handleHealth, handleReady, isHealthEndpointConfigured } from './health';
import { getMetricsRegister, recordOrderPlaced } from './metrics';
import { processPayment, setPaymentChaos, isPaymentChaosActive } from './payment';
import { saveOrder, getOrderById, getAllOrders, OrderRecord } from './db';
import { startSpanFromRequest, injectTraceContext } from './telemetry';
import { Logger } from './logger';

export function createOrderRoutes(logger: Logger): Router {
  const router = Router();
  const productServiceUrl = process.env.PRODUCT_SERVICE_URL || 'http://localhost:4001';

  // Health and Readiness
  router.get('/health', async (req: Request, res: Response) => {
    const isConfigured = isHealthEndpointConfigured('order-service', '/health');
    if (!isConfigured) {
      return res.status(404).json({ error: 'Endpoint /health not configured in health-checks.yaml' });
    }
    const health = await handleHealth('order-service');
    return res.json(health);
  });

  router.get('/ready', async (req: Request, res: Response) => {
    const isConfigured = isHealthEndpointConfigured('order-service', '/ready');
    if (!isConfigured) {
      return res.status(404).json({
        status: 'NOT_CONFIGURED',
        error: 'Readiness check not configured in health-checks.yaml for order-service',
      });
    }
    const ready = await handleReady('order-service');
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

  // Orders
  router.post('/orders', async (req: Request, res: Response) => {
    const { span, end } = startSpanFromRequest('order-service', 'POST /orders', req.headers);
    const orderId = `ord-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;

    try {
      const {
        customerId = 'cust-default',
        items = [],
        paymentMethod = 'credit_card',
        cardNumber,
        forceChaosFailure,
      } = req.body || {};

      if (!Array.isArray(items) || items.length === 0) {
        logger.warn('Order rejected: empty items list', { orderId, customerId });
        end();
        return res.status(400).json({ error: 'Order must contain at least one item' });
      }

      logger.info('Processing order placement', { orderId, customerId, itemCount: items.length });

      // Step 1: Call product-service to reserve stock (service-to-service distributed call with trace propagation)
      let totalAmount = 0;
      const verifiedItems = [];

      for (const item of items) {
        const prodId = item.productId || 'prod-1';
        const qty = Number(item.quantity || 1);

        // Propagate trace context to product-service
        const outgoingHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        injectTraceContext(outgoingHeaders);

        try {
          // Reserve stock on product-service
          const reserveRes = await fetch(`${productServiceUrl}/products/${prodId}/reserve`, {
            method: 'POST',
            headers: outgoingHeaders,
            body: JSON.stringify({ quantity: qty }),
          });

          if (!reserveRes.ok) {
            const errBody: any = await reserveRes.json().catch(() => ({}));
            logger.warn('Failed to reserve product on product-service', {
              orderId,
              productId: prodId,
              status: reserveRes.status,
              error: errBody.error,
            });

            const failedOrder: OrderRecord = {
              id: orderId,
              customer_id: customerId,
              status: 'CANCELLED',
              total_amount: 0,
              items: [{ productId: prodId, quantity: qty, unitPrice: 0 }],
              payment_method: paymentMethod,
              failure_reason: `Product reservation failed: ${errBody.error || 'Stock unavailable'}`,
            };
            await saveOrder(failedOrder);
            recordOrderPlaced('failed');
            end();
            return res.status(reserveRes.status).json({
              error: 'Order cancelled due to stock reservation failure',
              detail: errBody,
            });
          }

          // Fetch product price
          const prodRes = await fetch(`${productServiceUrl}/products/${prodId}`, {
            headers: outgoingHeaders,
          });
          const prodData: any = prodRes.ok ? await prodRes.json() : { price: 99.99 };
          const price = Number(prodData.price || 99.99);

          totalAmount += price * qty;
          verifiedItems.push({ productId: prodId, quantity: qty, unitPrice: price });
        } catch (fetchErr: any) {
          logger.error('Downstream product-service communication error', {
            orderId,
            productId: prodId,
            error: fetchErr.message,
          });
          end();
          return res.status(502).json({ error: 'Downstream product-service unavailable' });
        }
      }

      // Step 2: Payment processing
      const payment = await processPayment({
        orderId,
        amount: totalAmount,
        paymentMethod,
        cardNumber,
        forceChaosFailure,
      });

      if (!payment.success) {
        logger.error('Order payment failed', {
          orderId,
          customerId,
          totalAmount,
          reason: payment.failureReason,
        });

        const failedOrder: OrderRecord = {
          id: orderId,
          customer_id: customerId,
          status: 'PAYMENT_FAILED',
          total_amount: totalAmount,
          items: verifiedItems,
          payment_method: paymentMethod,
          failure_reason: payment.failureReason,
        };
        await saveOrder(failedOrder);
        recordOrderPlaced('failed');
        end();
        return res.status(402).json({
          error: 'Payment processing failed',
          reason: payment.failureReason,
          orderId,
        });
      }

      // Step 3: Confirm order
      const completedOrder: OrderRecord = {
        id: orderId,
        customer_id: customerId,
        status: 'CONFIRMED',
        total_amount: Math.round(totalAmount * 100) / 100,
        items: verifiedItems,
        payment_method: paymentMethod,
        payment_reference: payment.paymentReference,
      };

      const saved = await saveOrder(completedOrder);
      recordOrderPlaced('success');
      logger.info('Order successfully placed and confirmed', {
        orderId,
        customerId,
        totalAmount: saved.total_amount,
        paymentRef: payment.paymentReference,
      });

      end();
      return res.status(201).json(saved);
    } catch (err: any) {
      logger.error('Unexpected order processing error', { orderId, error: err.message });
      end();
      return res.status(500).json({ error: 'Internal order processing error' });
    }
  });

  router.get('/orders/:id', async (req: Request, res: Response) => {
    const orderId = req.params.id;
    const { span, end } = startSpanFromRequest('order-service', `GET /orders/${orderId}`, req.headers);
    try {
      const order = await getOrderById(orderId);
      if (!order) {
        logger.warn('Order not found', { orderId });
        end();
        return res.status(404).json({ error: `Order ${orderId} not found` });
      }
      logger.info('Order retrieved', { orderId, status: order.status });
      end();
      return res.json(order);
    } catch (err: any) {
      logger.error('Failed to retrieve order', { orderId, error: err.message });
      end();
      return res.status(500).json({ error: 'Failed to retrieve order' });
    }
  });

  router.get('/orders', async (req: Request, res: Response) => {
    const { span, end } = startSpanFromRequest('order-service', 'GET /orders', req.headers);
    try {
      const orders = await getAllOrders();
      logger.info('Listed orders', { count: orders.length });
      end();
      return res.json(orders);
    } catch (err: any) {
      logger.error('Failed to list orders', { error: err.message });
      end();
      return res.status(500).json({ error: 'Failed to list orders' });
    }
  });

  // Chaos endpoint for Order Service
  router.post('/chaos/payment', (req: Request, res: Response) => {
    const active = Boolean(req.body?.active);
    setPaymentChaos(active);
    logger.warn(`Order Service payment chaos set to: ${active}`);
    return res.json({ paymentChaosActive: isPaymentChaosActive() });
  });

  return router;
}
