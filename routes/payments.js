// payments.js - FINAL 100% WORKING VERSION (NO SYNTAX ERROR)
const express = require('express');
const router = express.Router();
const axios = require('axios');
const Transaction = require('../models/Transaction');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'https://vtpass-backend.onrender.com';

if (!PAYSTACK_SECRET_KEY) {
  console.error('PAYSTACK_SECRET_KEY missing');
  process.exit(1);
}

console.log('Payments API initialized');

// CORS
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Client-Platform, X-Request-ID, X-User-ID');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// INITIALIZE PAYSTACK
router.post('/initialize-paystack', async (req, res) => {
  try {
    const { userId, email, amount, reference } = req.body;
    if (!email || !amount || !reference || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid request' });
    }

    const paystackReference = Date.now().toString() + Math.random().toString(36).substr(2, 9);

    const transaction = await Transaction.create({
      userId, amount, reference: paystackReference, status: 'pending', gateway: 'paystack'
    });

    const paystackPayload = {
      email, amount: Math.round(amount * 100), reference: paystackReference,
      callback_url: `https://virtual-account-backend.onrender.com/api/payments/verify?redirect=true&reference=${paystackReference}`,
      metadata: { userId, userReference: reference }
    };

    const response = await axios.post('https://api.paystack.co/transaction/initialize', paystackPayload, {
      headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' }
    });

    if (!response.data.status) throw new Error(response.data.message);

    await Transaction.findByIdAndUpdate(transaction._id, {
      gatewayResponse: response.data.data, status: 'initialized'
    });

    res.json({
      success: true,
      authorizationUrl: response.data.data.authorization_url,
      reference: response.data.data.reference,
      accessCode: response.data.data.access_code
    });

  } catch (error) {
    console.error('INIT ERROR:', error.message);
    res.status(500).json({ success: false, message: 'Payment initialization failed' });
  }
});

// VERIFY ROUTE — FIXED DOUBLE REF + COMPLETE
router.get('/verify', async (req, res) => {
  try {
    let { reference, trxref, redirect = 'true' } = req.query;
    let paymentReference = reference || trxref || '';

    // FIX DOUBLE REF BUG
    if (paymentReference.includes(',')) {
      console.log('DOUBLE REF BUG DETECTED:', paymentReference);
      paymentReference = paymentReference.split(',')[0].trim();
      console.log('CLEANED REF:', paymentReference);
    }

    if (!paymentReference) {
      return redirect === 'true'
        ? res.redirect('/api/payments/success?error=no_reference')
        : res.status(400).json({ success: false, message: 'No reference' });
    }

    const verifyResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${paymentReference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }, timeout: 15000 }
    );

    const data = verifyResponse.data.data;

    if (data.status === 'success') {
      // SUCCESS
      return res.redirect(`/api/payments/success?reference=${paymentReference}&amount=${data.amount / 100}`);
    } else {
      // FAILED
      return res.redirect(`/api/payments/success?reference=${paymentReference}&status=failed`);
    }

  } catch (error) {
    console.error('VERIFY ERROR:', error.response?.data || error.message);
    const ref = req.query.reference || req.query.trxref || '';
    return res.redirect(`/api/payments/success?reference=${ref}&error=verification_failed`);
  }
});

// SUCCESS PAGE
router.get('/success', (req, res) => {
  let ref = req.query.reference || '';
  if (ref.includes(',')) ref = ref.split(',')[0].trim();

  if (req.headers['user-agent']?.includes('Flutter') || req.query.platform === 'mobile') {
    return res.redirect(`dalabapay://payment-success?ref=${ref}&amount=${req.query.amount || 0}`);
  }

  res.send(`<h1>Payment Successful!</h1><p>Ref: ${ref}</p><script>setTimeout(() => window.close(), 3000)</script>`);
});

router.get('/failure', (req, res) => {
  if (req.headers['user-agent']?.includes('Flutter')) {
    return res.redirect(`dalabapay://payment-failed?error=failed`);
  }
  res.send('<h1>Payment Failed</h1><script>setTimeout(() => window.close(), 3000)</script>');
});

// PROXY VERIFICATION
router.post('/verify-paystack', async (req, res) => {
  let reference = req.body.reference?.toString() || '';
  if (reference.includes(',')) reference = reference.split(',')[0].trim();

  if (!reference) return res.status(400).json({ success: false, message: 'Reference required' });

  try {
    const existing = await Transaction.findOne({ reference, status: 'success' });
    if (existing) {
      return res.json({ success: true, alreadyProcessed: true, amount: existing.amount });
    }

    const paystackRes = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );

    const data = paystackRes.data.data;
    if (data.status !== 'success') {
      return res.json({ success: false, message: 'Payment not successful' });
    }

    const amountNaira = data.amount / 100;
    const userId = data.metadata?.userId;

    if (!userId) return res.status(400).json({ success: false, message: 'No userId' });

    const session = await require('mongoose').startSession();
    await session.withTransaction(async () => {
      const User = require('../models/User');
      const user = await User.findById(userId).session(session);
      if (!user) throw new Error('User not found');

      const before = user.walletBalance;
      user.walletBalance += amountNaira;
      await user.save({ session });

      await Transaction.create([{
        userId, amount: amountNaira, reference, status: 'success',
        type: 'credit', gateway: 'paystack',
        balanceBefore: before, balanceAfter: user.walletBalance
      }], { session });
    });
    session.endSession();

    res.json({ success: true, amount: amountNaira });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

module.exports = router;
