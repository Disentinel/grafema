/**
 * Notifications Service - HTTP API
 *
 * Entrypoint for notifications service
 */

import express from 'express';
import { initEmailQueue, consumeEmailEvents, sendEmail, sendWelcomeEmail, sendOrderConfirmation } from './email.js';
import { sendSMS, sendVerificationCode, sendOrderUpdate, sendAlert } from './sms.js';

const app = express();
const PORT = process.env.NOTIFICATIONS_PORT || 3003;

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'notifications' });
});

// Send email
app.post('/api/notifications/email', async (req, res) => {
  try {
    const { to, subject, text, html, templateId, dynamicData } = req.body;
    const result = await sendEmail({ to, subject, text, html, templateId, dynamicData });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Send welcome email
app.post('/api/notifications/welcome', async (req, res) => {
  try {
    const { email, name } = req.body;
    const result = await sendWelcomeEmail(email, name);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Send order confirmation
app.post('/api/notifications/order-confirmation', async (req, res) => {
  try {
    const { email, orderData } = req.body;
    const result = await sendOrderConfirmation(email, orderData);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Send SMS
app.post('/api/notifications/sms', async (req, res) => {
  try {
    const { to, message } = req.body;
    const result = await sendSMS(to, message);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Send verification code
app.post('/api/notifications/verify', async (req, res) => {
  try {
    const { phoneNumber, code } = req.body;
    const result = await sendVerificationCode(phoneNumber, code);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Send order update SMS
app.post('/api/notifications/order-update', async (req, res) => {
  try {
    const { phoneNumber, orderData } = req.body;
    const result = await sendOrderUpdate(phoneNumber, orderData);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Send alert
app.post('/api/notifications/alert', async (req, res) => {
  try {
    const { phoneNumber, alertData } = req.body;
    const result = await sendAlert(phoneNumber, alertData);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Initialize queues and start server
async function start() {
  await initEmailQueue();
  await consumeEmailEvents();

  app.listen(PORT, () => {
    console.log(`Notifications service running on port ${PORT}`);
  });
}

start().catch(console.error);
