const express = require('express');
const router = express.Router();
const axios = require('axios');
const path = require('path');
const Transaction = require('../models/Transaction');
const VirtualAccount = require('../models/VirtualAccount');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'https://vtpass-backend.onrender.com';

if (!PAYSTACK_SECRET_KEY) {
  console.error('PAYSTACK_SECRET_KEY missing in environment');
}

router.get('/verify', async (req, res) => {
  try {
    const { reference, trxref, redirect = 'true' } = req.query;
    const paymentReference = reference || trxref;
    console.log(`Verifying Paystack Payment: ${paymentReference}`);

    if (!paymentReference) {
      return res.redirect('/api/payments/success');
    }

    const verifyResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${paymentReference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
        timeout: 15000,
      }
    );

    const data = verifyResponse.data.data;
    console.log('Paystack verification response:', {
      status: data.status,
      reference: data.reference,
      amount: data.amount,
      gateway_response: data.gateway_response,
    });

    if (!data || data.status !== 'success') {
      console.log('Payment verification failed');
      if (redirect === 'true')
        return res.redirect(`/api/payments/success?reference=${paymentReference}`);
      return res.status(400).json({ success: false, message: 'Payment not successful' });
    }

    const amount = data.amount / 100;
    const userId = data.metadata?.userId || data.customer?.email;

    let transaction = await Transaction.findOne({ reference: paymentReference });
    if (!transaction) {
      transaction = await Transaction.create({
        userId,
        type: 'wallet_funding',
        amount,
        reference: paymentReference,
        status: 'success',
        gateway: 'paystack',
        gatewayResponse: data,
        description: 'Wallet funding via Paystack',
      });
      console.log('Transaction recorded:', paymentReference);
    }

    const syncResult = await syncWithMainBackend(userId, amount, paymentReference);

    if (redirect === 'true') {
      return res.redirect(`/api/payments/success?reference=${paymentReference}`);
    }

    res.json({
      success: true,
      message: 'Payment verified successfully',
      amount,
      reference: paymentReference,
      newBalance: syncResult.newBalance,
      transactionId: transaction._id,
    });
  } catch (error) {
    console.error('Verify payment error:', error.response?.data || error.message);
    const { reference, trxref } = req.query;
    const paymentReference = reference || trxref;

    if (req.query.redirect === 'true' && paymentReference) {
      return res.redirect(`/api/payments/success?reference=${paymentReference}`);
    }

    res.status(500).json({
      success: false,
      message: 'Payment verification failed internally',
    });
  }
});

router.post('/initialize', async (req, res) => {
  try {
    const { userId, email, amount, reference } = req.body;
    console.log('Initializing Paystack:', { userId, email, amount });

    if (!email || !amount || !reference) {
      return res.status(400).json({ success: false, message: 'Missing parameters' });
    }

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: amount * 100,
        reference,
        callback_url: 'https://virtual-account-backend.onrender.com/api/payments/verify?redirect=true',
        metadata: { userId },
      },
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
      }
    );

    res.json({
      success: true,
      authorizationUrl: response.data.data.authorization_url,
      reference: response.data.data.reference,
    });
  } catch (error) {
    console.error('Initialize error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: 'Payment initialization failed',
    });
  }
});

async function syncWithMainBackend(userId, amount, reference) {
  let retries = 0;
  const maxRetries = 3;
  const url = `${MAIN_BACKEND_URL}/api/wallet/top-up`;

  while (retries < maxRetries) {
    try {
      console.log(`Syncing payment → Main Backend (Attempt ${retries + 1})`);

      const syncResponse = await axios.post(
        url,
        {
          userId,
          amount,
          reference,
          source: 'paystack_funding',
          description: 'Wallet funding via Paystack',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      if (syncResponse.data.success) {
        console.log('Main backend sync successful');
        return { success: true, newBalance: syncResponse.data.newBalance || 0 };
      } else {
        throw new Error(syncResponse.data.message || 'Main backend rejected sync');
      }
    } catch (error) {
      const status = error.response?.status;
      if (status === 429) {
        retries++;
        console.warn(`Too Many Requests (429) — Retrying in ${retries * 2}s`);
        await new Promise((r) => setTimeout(r, retries * 2000));
      } else if (status === 404) {
        console.error('Main backend endpoint not found:', url);
        break;
      } else {
        console.error('Sync failed:', error.response?.data || error.message);
        break;
      }
    }
  }

  return { success: false, newBalance: 0 };
}

router.get('/wallet/balance/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`Fetching wallet balance for user ${userId}`);

    const response = await axios.get(`${MAIN_BACKEND_URL}/api/users/balance/${userId}`);
    res.json({
      success: true,
      walletBalance: response.data.walletBalance,
      userId,
    });
  } catch (error) {
    console.error('Wallet balance error:', error.response?.data || error.message);
    res.status(500).json({ success: false, message: 'Could not fetch wallet balance' });
  }
});

router.get('/success', (req, res) => {
  const filePath = path.join(__dirname, '../public/payment-success.html');
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error('Error sending success page:', err);
      res.status(404).send('Success page not found');
    }
  });
});

module.exports = router;
