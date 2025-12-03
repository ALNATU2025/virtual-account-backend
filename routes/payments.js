const express = require('express');
const router = express.Router();
const axios = require('axios');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'https://vtpass-backend.onrender.com';

// CORS middleware
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// ========== INITIALIZE PAYMENT ==========
router.post('/initialize-paystack', async (req, res) => {
  try {
    const { userId, email, amount, reference } = req.body;
    
    if (!email || !amount || !reference) {
      return res.status(400).json({ success: false, message: 'Missing parameters' });
    }

    // Create transaction
    const transaction = await Transaction.create({
      userId,
      type: 'wallet_funding',
      amount: amount,
      reference: reference,
      status: 'pending',
      gateway: 'paystack',
      description: 'Wallet funding initialization'
    });

    // Initialize with PayStack
    const paystackPayload = {
      email: email,
      amount: Math.round(amount * 100),
      reference: reference,
      callback_url: `https://virtual-account-backend.onrender.com/api/payments/verify?reference=${reference}`,
      metadata: { 
        userId: userId,
        transactionId: transaction._id.toString()
      },
    };

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      paystackPayload,
      {
        headers: { 
          'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    if (!response.data.status) {
      throw new Error(response.data.message || 'PayStack initialization failed');
    }

    const paystackData = response.data.data;
    
    // Update transaction
    await Transaction.findByIdAndUpdate(transaction._id, {
      gatewayResponse: paystackData,
      status: 'initialized'
    });

    // Return success
    res.json({
      success: true,
      authorizationUrl: paystackData.authorization_url,
      reference: paystackData.reference,
      accessCode: paystackData.access_code,
      message: 'Payment initialized',
      transactionId: transaction._id
    });

  } catch (error) {
    console.error('❌ INITIALIZE ERROR:', error.message);
    res.status(500).json({
      success: false,
      message: 'Payment initialization failed',
      error: error.message
    });
  }
});

// ========== VERIFICATION ENDPOINT (Used by Flutter) ==========
router.post('/verify-paystack', async (req, res) => {
  let reference = req.body.reference;

  try {
    // Clean reference
    if (typeof reference === 'string' && reference.includes(',')) {
      reference = reference.split(',')[0].trim();
    }

    if (!reference || reference.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Payment reference is required'
      });
    }

    reference = reference.trim();

    // Check if already processed
    const existing = await Transaction.findOne({
      reference,
      status: 'success'
    });

    if (existing) {
      // Get user balance
      let newBalance = 0;
      if (existing.userId) {
        const user = await User.findById(existing.userId);
        if (user) newBalance = user.walletBalance;
      }

      return res.json({
        success: true,
        alreadyProcessed: true,
        amount: existing.amount,
        newBalance: newBalance,
        message: 'Payment already verified'
      });
    }

    // Verify with PayStack
    const paystackResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
        timeout: 15000
      }
    );

    const data = paystackResponse.data;

    if (!data.status || !data.data) {
      throw new Error(data.message || 'Invalid PayStack response');
    }

    if (data.data.status !== 'success') {
      return res.json({
        success: false,
        status: data.data.status,
        message: 'Payment not successful',
        reference
      });
    }

    // SUCCESS: Process payment
    const amountNaira = data.data.amount / 100;
    const userId = data.data.metadata?.userId;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'userId not found in metadata'
      });
    }

    // Update user balance
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    const balanceBefore = user.walletBalance;
    user.walletBalance += amountNaira;
    await user.save();

    // Create transaction
    await Transaction.create({
      userId,
      type: 'credit',
      amount: amountNaira,
      status: 'success',
      reference,
      description: `Wallet funding via PayStack - Ref: ${reference}`,
      balanceBefore,
      balanceAfter: user.walletBalance,
      gateway: 'paystack',
      metadata: { paystackData: data.data }
    });

    // Sync with main backend (async)
    try {
      await axios.post(`${MAIN_BACKEND_URL}/api/wallet/top-up`, {
        userId: userId,
        amount: amountNaira,
        reference: reference,
        source: 'paystack_funding',
        description: `Wallet funding via PayStack - Ref: ${reference}`
      });
    } catch (syncError) {
      console.error('Sync failed:', syncError.message);
    }

    // Return SUCCESS with newBalance
    return res.json({
      success: true,
      amount: amountNaira,
      newBalance: user.walletBalance, // ✅ THIS IS CRITICAL
      reference: reference,
      message: 'Payment verified and wallet updated',
      userId: userId
    });

  } catch (error) {
    console.error('VERIFICATION ERROR:', error.message);
    
    if (error.response?.status === 404) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found on PayStack',
        reference
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Verification failed',
      error: error.message
    });
  }
});

// ========== WEBHOOK ==========
router.post('/webhook/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = JSON.parse(req.body.toString());
    
    if (event.event === 'charge.success') {
      const data = event.data;
      const reference = data.reference;
      const amount = data.amount / 100;
      const userId = data.metadata?.userId;
      
      // Update user if exists
      if (userId) {
        await User.findByIdAndUpdate(userId, {
          $inc: { walletBalance: amount }
        });
        
        // Create transaction
        await Transaction.create({
          userId,
          type: 'credit',
          amount: amount,
          status: 'success',
          reference,
          description: `Wallet funding via PayStack Webhook`,
          gateway: 'paystack'
        });
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Webhook failed');
  }
});

// ========== HEALTH CHECK ==========
router.get('/health', (req, res) => {
  res.json({ success: true, message: 'Payments API healthy' });
});

module.exports = router;
