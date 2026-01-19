/**
 * Payments Service - HTTP API
 *
 * Entrypoint for payments service
 */

import express from 'express';
import { createOrder, processPayment, refundOrder, getOrder, listUserOrders } from './orders.js';
import { initMessageQueue, consumePaymentEvents, handleStripeWebhook } from './webhooks.js';

const app = express();
const PORT = process.env.PAYMENTS_PORT || 3002;

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'payments' });
});

// Create order
app.post('/api/orders', async (req, res) => {
  try {
    const { userId, items, shippingAddress } = req.body;
    const result = await createOrder(userId, items, shippingAddress);
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get order by ID
app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List user orders
app.get('/api/users/:userId/orders', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const orders = await listUserOrders(req.params.userId, parseInt(page), parseInt(limit));
    res.json({ orders });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Process payment
app.post('/api/orders/:id/pay', async (req, res) => {
  try {
    const { paymentMethodId } = req.body;
    const result = await processPayment(req.params.id, paymentMethodId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Refund order
app.post('/api/orders/:id/refund', async (req, res) => {
  try {
    const result = await refundOrder(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Stripe webhook
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['stripe-signature'];
    const result = await handleStripeWebhook(req.body, signature);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Initialize message queue and start server
async function start() {
  await initMessageQueue();
  await consumePaymentEvents();

  app.listen(PORT, () => {
    console.log(`Payments service running on port ${PORT}`);
  });
}

start().catch(console.error);
