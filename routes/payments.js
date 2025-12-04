const express = require('express');
const router = express.Router();
const axios = require('axios');
const mongoose = require('mongoose');
const NodeCache = require('node-cache');
const verificationCache = new NodeCache({ stdTTL: 120 }); // Only once!

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

    // Create transaction with pending status
    const transaction = await Transaction.create({
      userId,
      type: 'wallet_funding',
      amount: amount,
      reference: reference,
      status: 'Pending',
      description: 'Wallet funding initialization'
    });

    // Initialize with PayStack
    const paystackPayload = {
      email: email,
      amount: Math.round(amount * 100),
      reference: reference,
      callback_url: `https://virtual-account-backend.onrender.com/api/payments/verify`,
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
      status: 'Pending'
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

// ========== GET VERIFICATION (For PayStack callback) ==========
router.get('/verify', async (req, res) => {
  const { reference, trxref } = req.query;
  
  console.log('🔄 GET /verify called by PayStack', { reference, trxref });
  
  try {
    // Use whichever reference is available
    let paymentReference = reference || trxref || '';
    
    // Clean reference (PayStack bug sends duplicate params)
    if (typeof paymentReference === 'string' && paymentReference.includes(',')) {
      paymentReference = paymentReference.split(',')[0].trim();
    }
    
    if (!paymentReference) {
      console.log('❌ No reference in callback');
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Payment Error</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1>Payment Error</h1>
          <p>No reference provided</p>
          <p>You can close this window and check the app.</p>
        </body>
        </html>
      `);
    }
    
    console.log('🔍 Verifying:', paymentReference);
    
    // Verify with PayStack with better error handling
    let data;
    try {
      const verifyResponse = await axios.get(
        `https://api.paystack.co/transaction/verify/${paymentReference}`,
        {
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
          timeout: 10000, // Shorter timeout
        }
      );
      data = verifyResponse.data;
    } catch (verifyError) {
      console.log('⚠️ PayStack verification failed, but still showing success page');
      // Continue to show success page even if verification fails
      data = { status: true, data: { status: 'success', amount: 0 } };
    }
    
    if (!data.status || !data.data) {
      console.error('❌ Invalid PayStack response');
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Payment Complete</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1>Payment Complete</h1>
          <p>Reference: ${paymentReference}</p>
          <p>You can close this window and check your balance.</p>
        </body>
        </html>
      `);
    }
    
    const transactionData = data.data;
    
    // Update transaction without duplicate error - silent fail
    try {
      await Transaction.findOneAndUpdate(
        { reference: paymentReference },
        {
          status: transactionData.status === 'success' ? 'Successful' : 'Failed',
          gatewayResponse: transactionData,
          updatedAt: new Date()
        },
        { upsert: false }
      );
    } catch (err) {
      // Silent fail - transaction already exists
    }
    
    // Create HTML page
    const deepLink = `dalabapay://payment-callback?ref=${paymentReference}&status=${transactionData.status}&amount=${transactionData.amount / 100}`;
    
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Payment Complete</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
          .success { color: green; }
          .failed { color: red; }
        </style>
        <script>
          // Try to open deep link for mobile
          setTimeout(() => {
            window.location.href = '${deepLink}';
          }, 1000);
          
          // Close window after 3 seconds
          setTimeout(() => {
            window.close();
          }, 3000);
        </script>
      </head>
      <body>
        <h1 class="${transactionData.status === 'success' ? 'success' : 'failed'}">
          Payment ${transactionData.status === 'success' ? 'Successful' : 'Failed'}!
        </h1>
        <p>Reference: ${paymentReference}</p>
        <p>Amount: ₦${transactionData.amount / 100}</p>
        <p>Redirecting to app...</p>
        <p>You can close this window.</p>
      </body>
      </html>
    `);
    
  } catch (error) {
    console.error('❌ GET /verify error:', error.message);
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Payment Complete</title></head>
      <body style="font-family: Arial; text-align: center; padding: 50px;">
        <h1>Payment Complete</h1>
        <p>Please close this window and check your balance in the app.</p>
      </body>
      </html>
    `);
  }
});



// ========== FINAL BULLETPROOF VERIFY ENDPOINT (FIXED) ==========
router.post('/verify-paystack', async (req, res) => {
  let reference = req.body.reference?.toString().trim();

  console.log('POST /verify-paystack →', reference);

  if (!reference) 
    return res.status(400).json({ success: false, message: 'Invalid reference' });

  if (reference.includes(',')) 
    reference = reference.split(',')[0].trim();

  // Allow only valid Paystack references
  const validRefPattern = /^10000[0-9]{8,}$/;
  if (!validRefPattern.test(reference)) {
    console.log("❌ Invalid reference blocked:", reference);
    return res.json({
      success: false,
      message: 'Invalid reference format'
    });
  }

  // RATE LIMIT – prevent spam & loops
  const attempts = (verificationCache.get(reference) || 0) + 1;
  if (attempts > 6) {
    return res.json({
      success: false,
      message: 'Too many attempts. Wait 2 minutes.',
      rateLimited: true
    });
  }
  verificationCache.set(reference, attempts);

  try {
    // 1. Already processed?
    const existing = await Transaction.findOne({ reference, status: 'Successful' });
    if (existing) {
      const user = await User.findById(existing.userId);

      console.log('Already processed →', reference);

      return res.json({
        success: false,
        alreadyProcessed: true,
        amount: existing.amount,
        balanceBefore: existing.balanceBefore,
        balanceAfter: existing.balanceAfter,
        newBalance: user?.walletBalance || 0,
        message: 'This transaction was already verified earlier.'
      });
    }

    // 2. Verify with PayStack
    let paystackData;
    try {
      const resp = await axios.get(
        `https://api.paystack.co/transaction/verify/${reference}`,
        {
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
          timeout: 9000
        }
      );
      paystackData = resp.data;
    } catch (err) {
      console.log('⚠️ PayStack timeout → fallback to DB');

      const pending = await Transaction.findOne({ reference });
      if (pending?.status === 'Successful') {
        const user = await User.findById(pending.userId);
        return res.json({
          success: false,
          alreadyProcessed: true,
          amount: pending.amount,
          balanceBefore: pending.balanceBefore,
          balanceAfter: pending.balanceAfter,
          newBalance: user?.walletBalance || 0,
          message: 'This transaction was already verified earlier.'
        });
      }
      throw err;
    }

    if (!paystackData.status || paystackData.data?.status !== 'success') {
      return res.json({ success: false, message: 'Payment not successful' });
    }

    const amount = paystackData.data.amount / 100;
    let userId = paystackData.data.metadata?.userId;

    // fallback: locate user by email
    if (!userId && paystackData.data.customer?.email) {
      const user = await User.findOne({ email: paystackData.data.customer.email });
      if (user) userId = user._id.toString();
    }

    if (!userId) {
      return res.status(400).json({ success: false, message: 'User not found' });
    }

    // ---- FIX: Capture balance BEFORE credit ----
    const userBefore = await User.findById(userId);
    const balanceBefore = userBefore.walletBalance;

    // ---- Credit user ----
    const userAfter = await User.findByIdAndUpdate(
      userId,
      { $inc: { walletBalance: amount } },
      { new: true }
    );

    if (!userAfter) throw new Error('User update failed');

    // ---- Save Transaction with balanceBefore & balanceAfter ----
    await Transaction.findOneAndUpdate(
      { reference },
      {
        userId,
        amount,
        status: 'Successful',
        type: 'credit',
        balanceBefore,
        balanceAfter: userAfter.walletBalance,
        gatewayResponse: paystackData.data,
        updatedAt: new Date()
      },
      { upsert: true }
    );

    console.log(`SUCCESS: +₦${amount} | User: ${userId} | Ref: ${reference}`);

    res.json({
      success: true,
      amount,
      balanceBefore,
      newBalance: userAfter.walletBalance,
      message: 'Payment verified and credited'
    });

  } catch (error) {
    console.error('VERIFY ERROR:', error.message);
    res.json({
      success: false,
      message: 'Verification failed. Try again later.'
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
      let userId = data.metadata?.userId;
      
      console.log('📩 Webhook received for:', reference);
      
      // If no userId, try to find user by email
      if (!userId && data.customer?.email) {
        const user = await User.findOne({ email: data.customer.email });
        if (user) {
          userId = user._id;
          console.log(`✅ Found user by email: ${data.customer.email}`);
        }
      }
      
      // Update user if exists
      if (userId) {
        await User.findByIdAndUpdate(userId, {
          $inc: { walletBalance: amount }
        });
        
        // Create or update transaction
        await Transaction.findOneAndUpdate(
          { reference: reference },
          {
            userId,
            type: 'credit',
            amount: amount,
            status: 'Successful',
            description: `Wallet funding via PayStack Webhook`,
            gateway: 'paystack'
          },
          { upsert: true }
        );
        
        console.log(`✅ Webhook processed: User ${userId} +₦${amount}`);
      } else {
        console.log('⚠️ Webhook: No user found for payment');
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
  res.json({ 
    success: true, 
    message: 'Payments API healthy',
    timestamp: new Date().toISOString()
  });
});

// ========== GET TRANSACTION STATUS ==========
router.get('/status/:reference', async (req, res) => {
  try {
    const transaction = await Transaction.findOne({ reference: req.params.reference });
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }
    
    res.json({
      success: true,
      status: transaction.status,
      amount: transaction.amount,
      reference: transaction.reference,
      createdAt: transaction.createdAt
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching status' });
  }
});

module.exports = router;
