const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const Transaction = require('../models/Transaction');
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'https://vtpass-backend.onrender.com';

const bodyParser = require('body-parser');

router.post('/paystack', bodyParser.raw({ type: '*/*' }), async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const computedHash = crypto
      .createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest('hex');

    if (computedHash !== signature) {
      console.log('Invalid webhook signature');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    const event = JSON.parse(req.body.toString());
    console.log('Valid PayStack webhook received:', event.event);

    if (event.event === 'charge.success') {
      await handleSuccessfulCharge(event.data);
    } else if (event.event === 'transfer.success') {
      await handleSuccessfulTransfer(event.data);
    } else {
      console.log(`Unhandled webhook event: ${event.event}`);
    }

    res.json({ success: true, message: 'Webhook processed successfully' });
  } catch (error) {
    console.error('Webhook processing error:', error.message);
    res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
});

async function handleSuccessfulCharge(chargeData) {
  try {
    console.log('Processing successful charge:', chargeData.reference);

    const amountInNaira = chargeData.amount / 100;
    const userId = chargeData.metadata?.userId || chargeData.customer?.metadata?.userId;

    if (!userId) {
      console.log('No userId found, skipping wallet update');
      return;
    }

    const existing = await Transaction.findOne({ reference: chargeData.reference });
    if (existing) {
      console.log('Transaction already exists:', chargeData.reference);
      return;
    }

    await Transaction.create({
      userId,
      type: 'wallet_funding',
      amount: amountInNaira,
      reference: chargeData.reference,
      status: 'success',
      gateway: 'paystack',
      gatewayResponse: chargeData,
      description: 'Wallet funded via Paystack webhook',
    });

    console.log('Transaction recorded:', chargeData.reference);

    await axios.post(`${MAIN_BACKEND_URL}/api/wallet/top-up`, {
      userId,
      amount: amountInNaira,
      reference: chargeData.reference,
      type: 'credit',
      description: `Wallet funding via PayStack - Ref: ${chargeData.reference}`,
      source: 'paystack_webhook'
    });

    console.log('Wallet successfully updated for user:', userId);
  } catch (error) {
    console.error('Error processing charge:', error.message);
  }
}

async function handleSuccessfulTransfer(transferData) {
  console.log('Transfer successful:', transferData.reference);
}

router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Webhook endpoint active',
    webhook_url: 'https://virtual-account-backend.onrender.com/api/webhooks/paystack'
  });
});

module.exports = router;
