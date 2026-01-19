/**
 * Email Service - Email Notifications
 *
 * Handles sending email notifications
 * External connections: saas:sendgrid, event:rabbitmq (consume)
 */

import sgMail from '@sendgrid/mail';
import amqp from 'amqplib';

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@example.com';
const FROM_NAME = process.env.FROM_NAME || 'Navi App';

let channel = null;

/**
 * Initialize message queue for email events
 */
export async function initEmailQueue() {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  channel = await connection.createChannel();

  // Declare email queue
  await channel.assertQueue('email.send', { durable: true });
  await channel.assertQueue('email.batch', { durable: true });

  console.log('Email queue initialized');
}

/**
 * Start consuming email events
 */
export async function consumeEmailEvents() {
  if (!channel) {
    throw new Error('Email queue not initialized');
  }

  // Process individual emails
  channel.consume('email.send', async (msg) => {
    if (!msg) return;

    try {
      const emailRequest = JSON.parse(msg.content.toString());
      await sendEmail(emailRequest);
      channel.ack(msg);
    } catch (error) {
      console.error('Error sending email:', error);
      // Requeue on failure
      channel.nack(msg, false, true);
    }
  });

  // Process batch emails
  channel.consume('email.batch', async (msg) => {
    if (!msg) return;

    try {
      const batchRequest = JSON.parse(msg.content.toString());
      await sendBatchEmail(batchRequest);
      channel.ack(msg);
    } catch (error) {
      console.error('Error sending batch email:', error);
      channel.nack(msg, false, true);
    }
  });

  console.log('Started consuming email events');
}

/**
 * Send a single email via SendGrid
 */
export async function sendEmail({ to, subject, text, html, templateId, dynamicData }) {
  const msg = {
    to,
    from: {
      email: FROM_EMAIL,
      name: FROM_NAME
    },
    subject
  };

  if (templateId) {
    // Use SendGrid dynamic template
    msg.templateId = templateId;
    msg.dynamicTemplateData = dynamicData || {};
  } else {
    // Use plain text/HTML
    if (text) msg.text = text;
    if (html) msg.html = html;
  }

  const response = await sgMail.send(msg);

  return {
    success: true,
    messageId: response[0].headers['x-message-id']
  };
}

/**
 * Send batch emails via SendGrid
 */
export async function sendBatchEmail({ recipients, subject, text, html, templateId }) {
  const messages = recipients.map(recipient => ({
    to: recipient.email,
    from: {
      email: FROM_EMAIL,
      name: FROM_NAME
    },
    subject,
    text,
    html,
    templateId,
    dynamicTemplateData: recipient.data || {}
  }));

  const response = await sgMail.send(messages);

  return {
    success: true,
    sent: messages.length
  };
}

/**
 * Queue email for async sending
 */
export async function queueEmail(emailRequest) {
  if (!channel) {
    // Fall back to direct send if queue not available
    return sendEmail(emailRequest);
  }

  channel.sendToQueue(
    'email.send',
    Buffer.from(JSON.stringify(emailRequest)),
    { persistent: true }
  );

  return { queued: true };
}

/**
 * Send welcome email
 */
export async function sendWelcomeEmail(email, name) {
  return queueEmail({
    to: email,
    templateId: process.env.SENDGRID_WELCOME_TEMPLATE,
    dynamicData: {
      name,
      supportEmail: 'support@example.com'
    }
  });
}

/**
 * Send order confirmation email
 */
export async function sendOrderConfirmation(email, orderData) {
  return queueEmail({
    to: email,
    templateId: process.env.SENDGRID_ORDER_TEMPLATE,
    dynamicData: {
      orderId: orderData.orderId,
      items: orderData.items,
      total: orderData.total,
      shippingAddress: orderData.shippingAddress
    }
  });
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(email, resetLink) {
  return queueEmail({
    to: email,
    subject: 'Password Reset Request',
    html: `
      <h1>Password Reset</h1>
      <p>You requested a password reset. Click the link below to reset your password:</p>
      <p><a href="${resetLink}">Reset Password</a></p>
      <p>This link will expire in 1 hour.</p>
      <p>If you didn't request this, please ignore this email.</p>
    `
  });
}

/**
 * Send notification email
 */
export async function sendNotificationEmail(email, notification) {
  return queueEmail({
    to: email,
    subject: notification.title,
    html: `
      <h1>${notification.title}</h1>
      <p>${notification.message}</p>
      ${notification.actionUrl ? `<p><a href="${notification.actionUrl}">${notification.actionText || 'View Details'}</a></p>` : ''}
    `
  });
}
