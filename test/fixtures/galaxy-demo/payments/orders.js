/**
 * Orders Service - Payment Processing
 *
 * Handles order creation and payment processing
 * External connections: db:postgres, saas:stripe
 */

import { Pool } from 'pg';
import Stripe from 'stripe';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Create a new order
 */
export async function createOrder(userId, items, shippingAddress) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Calculate total
    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

    // Insert order
    const result = await client.query(
      'INSERT INTO orders (user_id, items, total, shipping_address, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [userId, JSON.stringify(items), total, JSON.stringify(shippingAddress), 'pending']
    );

    const orderId = result.rows[0].id;

    await client.query('COMMIT');

    return { orderId, total };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Process payment via Stripe
 */
export async function processPayment(orderId, paymentMethodId) {
  // Get order from database
  const orderResult = await pool.query(
    'SELECT * FROM orders WHERE id = $1',
    [orderId]
  );

  if (orderResult.rows.length === 0) {
    throw new Error('Order not found');
  }

  const order = orderResult.rows[0];

  // Create Stripe payment intent
  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(order.total * 100), // Stripe uses cents
    currency: 'usd',
    payment_method: paymentMethodId,
    confirm: true,
    metadata: {
      orderId: orderId.toString()
    }
  });

  // Update order status
  await pool.query(
    'UPDATE orders SET status = $1, stripe_payment_id = $2 WHERE id = $3',
    ['paid', paymentIntent.id, orderId]
  );

  return { success: true, paymentId: paymentIntent.id };
}

/**
 * Refund an order
 */
export async function refundOrder(orderId) {
  const orderResult = await pool.query(
    'SELECT * FROM orders WHERE id = $1',
    [orderId]
  );

  if (orderResult.rows.length === 0) {
    throw new Error('Order not found');
  }

  const order = orderResult.rows[0];

  if (!order.stripe_payment_id) {
    throw new Error('No payment to refund');
  }

  // Process refund via Stripe
  const refund = await stripe.refunds.create({
    payment_intent: order.stripe_payment_id
  });

  // Update order status
  await pool.query(
    'UPDATE orders SET status = $1, refund_id = $2 WHERE id = $3',
    ['refunded', refund.id, orderId]
  );

  return { success: true, refundId: refund.id };
}

/**
 * Get order by ID
 */
export async function getOrder(orderId) {
  const result = await pool.query(
    'SELECT * FROM orders WHERE id = $1',
    [orderId]
  );

  return result.rows[0] || null;
}

/**
 * List orders for a user
 */
export async function listUserOrders(userId, page = 1, limit = 20) {
  const offset = (page - 1) * limit;

  const result = await pool.query(
    'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
    [userId, limit, offset]
  );

  return result.rows;
}
