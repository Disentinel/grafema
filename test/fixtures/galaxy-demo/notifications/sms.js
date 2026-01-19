/**
 * SMS Service - SMS Notifications
 *
 * Handles sending SMS notifications
 * External connections: saas:twilio, file:s3 (logs)
 */

import twilio from 'twilio';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Initialize Twilio
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;

// Initialize S3 for logging
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1'
});

const LOG_BUCKET = process.env.SMS_LOG_BUCKET || 'sms-logs';

/**
 * Send SMS via Twilio
 */
export async function sendSMS(to, message) {
  const result = await twilioClient.messages.create({
    body: message,
    from: TWILIO_PHONE,
    to
  });

  // Log to S3 for audit
  await logSMSToS3({
    messageId: result.sid,
    to,
    message,
    status: result.status,
    sentAt: new Date().toISOString()
  });

  return {
    success: true,
    messageId: result.sid,
    status: result.status
  };
}

/**
 * Send verification code via SMS
 */
export async function sendVerificationCode(phoneNumber, code) {
  const message = `Your verification code is: ${code}. This code expires in 10 minutes.`;

  return sendSMS(phoneNumber, message);
}

/**
 * Send order status update via SMS
 */
export async function sendOrderUpdate(phoneNumber, orderData) {
  let message;

  switch (orderData.status) {
    case 'confirmed':
      message = `Order #${orderData.orderId} confirmed! Total: $${orderData.total}. Track at: ${orderData.trackingUrl}`;
      break;
    case 'shipped':
      message = `Order #${orderData.orderId} shipped! Tracking: ${orderData.trackingNumber}`;
      break;
    case 'delivered':
      message = `Order #${orderData.orderId} delivered! Thank you for your purchase.`;
      break;
    default:
      message = `Order #${orderData.orderId} update: ${orderData.status}`;
  }

  return sendSMS(phoneNumber, message);
}

/**
 * Send alert SMS
 */
export async function sendAlert(phoneNumber, alertData) {
  const message = `[ALERT] ${alertData.title}: ${alertData.message}`;

  return sendSMS(phoneNumber, message);
}

/**
 * Send batch SMS to multiple recipients
 */
export async function sendBatchSMS(recipients, message) {
  const results = [];

  for (const recipient of recipients) {
    try {
      const result = await sendSMS(recipient.phoneNumber,
        message.replace('{name}', recipient.name || 'Customer'));
      results.push({ phoneNumber: recipient.phoneNumber, ...result });
    } catch (error) {
      results.push({
        phoneNumber: recipient.phoneNumber,
        success: false,
        error: error.message
      });
    }
  }

  return results;
}

/**
 * Log SMS to S3 for audit trail
 */
async function logSMSToS3(logData) {
  const date = new Date();
  const key = `logs/${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}/${logData.messageId}.json`;

  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: LOG_BUCKET,
      Key: key,
      Body: JSON.stringify(logData, null, 2),
      ContentType: 'application/json'
    }));
  } catch (error) {
    console.error('Failed to log SMS to S3:', error);
    // Don't throw - logging failure shouldn't break SMS sending
  }
}

/**
 * Get SMS delivery status from Twilio
 */
export async function getSMSStatus(messageId) {
  const message = await twilioClient.messages(messageId).fetch();

  return {
    messageId: message.sid,
    status: message.status,
    errorCode: message.errorCode,
    errorMessage: message.errorMessage,
    price: message.price,
    priceUnit: message.priceUnit
  };
}

/**
 * Validate phone number format
 */
export function validatePhoneNumber(phoneNumber) {
  // E.164 format validation
  const e164Regex = /^\+[1-9]\d{1,14}$/;
  return e164Regex.test(phoneNumber);
}

/**
 * Format phone number to E.164
 */
export function formatPhoneNumber(phoneNumber, countryCode = '1') {
  // Remove all non-digit characters
  const digits = phoneNumber.replace(/\D/g, '');

  // Add country code if not present
  if (digits.length === 10) {
    return `+${countryCode}${digits}`;
  } else if (digits.length === 11 && digits.startsWith(countryCode)) {
    return `+${digits}`;
  }

  return `+${digits}`;
}
