/**
 * Webhooks Service - Event Processing
 *
 * Handles incoming webhooks from external services
 * External connections: event:rabbitmq (consume)
 */

import amqp from 'amqplib';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

let channel = null;

/**
 * Initialize RabbitMQ connection
 */
export async function initMessageQueue() {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  channel = await connection.createChannel();

  // Declare exchanges
  await channel.assertExchange('payments', 'topic', { durable: true });
  await channel.assertExchange('orders', 'topic', { durable: true });

  // Declare queues
  await channel.assertQueue('payment.events', { durable: true });
  await channel.assertQueue('order.updates', { durable: true });

  // Bind queues
  await channel.bindQueue('payment.events', 'payments', 'payment.*');
  await channel.bindQueue('order.updates', 'orders', 'order.*');

  console.log('Message queue initialized');
}

/**
 * Start consuming payment events
 */
export async function consumePaymentEvents() {
  if (!channel) {
    throw new Error('Message queue not initialized');
  }

  channel.consume('payment.events', async (msg) => {
    if (!msg) return;

    try {
      const event = JSON.parse(msg.content.toString());

      switch (event.type) {
        case 'payment.succeeded':
          await handlePaymentSuccess(event.data);
          break;
        case 'payment.failed':
          await handlePaymentFailure(event.data);
          break;
        case 'payment.refunded':
          await handlePaymentRefund(event.data);
          break;
        default:
          console.warn('Unknown payment event type:', event.type);
      }

      channel.ack(msg);
    } catch (error) {
      console.error('Error processing payment event:', error);
      channel.nack(msg, false, true);
    }
  });

  console.log('Started consuming payment events');
}

/**
 * Handle successful payment
 */
async function handlePaymentSuccess(data) {
  const { orderId, paymentId, amount } = data;

  await pool.query(
    'UPDATE orders SET status = $1, paid_at = NOW() WHERE id = $2',
    ['completed', orderId]
  );

  // Emit order completed event
  await publishEvent('orders', 'order.completed', {
    orderId,
    paymentId,
    amount,
    completedAt: new Date().toISOString()
  });
}

/**
 * Handle failed payment
 */
async function handlePaymentFailure(data) {
  const { orderId, error } = data;

  await pool.query(
    'UPDATE orders SET status = $1, error_message = $2 WHERE id = $3',
    ['payment_failed', error, orderId]
  );

  // Emit order failed event
  await publishEvent('orders', 'order.failed', {
    orderId,
    reason: 'payment_failed',
    error
  });
}

/**
 * Handle payment refund
 */
async function handlePaymentRefund(data) {
  const { orderId, refundId, amount } = data;

  await pool.query(
    'UPDATE orders SET status = $1, refunded_at = NOW() WHERE id = $2',
    ['refunded', orderId]
  );

  // Emit refund event
  await publishEvent('orders', 'order.refunded', {
    orderId,
    refundId,
    amount
  });
}

/**
 * Publish event to exchange
 */
export async function publishEvent(exchange, routingKey, data) {
  if (!channel) {
    throw new Error('Message queue not initialized');
  }

  const message = JSON.stringify({
    type: routingKey,
    data,
    timestamp: new Date().toISOString()
  });

  channel.publish(exchange, routingKey, Buffer.from(message), {
    persistent: true
  });
}

/**
 * Handle Stripe webhook
 */
export async function handleStripeWebhook(payload, signature) {
  const event = verifyStripeSignature(payload, signature);

  switch (event.type) {
    case 'payment_intent.succeeded':
      await publishEvent('payments', 'payment.succeeded', {
        orderId: event.data.object.metadata.orderId,
        paymentId: event.data.object.id,
        amount: event.data.object.amount / 100
      });
      break;

    case 'payment_intent.payment_failed':
      await publishEvent('payments', 'payment.failed', {
        orderId: event.data.object.metadata.orderId,
        error: event.data.object.last_payment_error?.message
      });
      break;

    case 'charge.refunded':
      await publishEvent('payments', 'payment.refunded', {
        orderId: event.data.object.metadata.orderId,
        refundId: event.data.object.refunds.data[0].id,
        amount: event.data.object.amount_refunded / 100
      });
      break;
  }

  return { received: true };
}

/**
 * Verify Stripe webhook signature
 */
function verifyStripeSignature(payload, signature) {
  // In real implementation, use Stripe SDK
  return JSON.parse(payload);
}
