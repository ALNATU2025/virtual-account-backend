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

    // Create transaction with pending status
    const transaction = await Transaction.create({
      userId,
      type: 'wallet_funding',
      amount: amount,
      reference: reference,
      status: 'Pending',
      description: 'Wallet funding initialization'
    });

    // Initialize with PayStack - use deep link for mobile
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
    
    // Verify with PayStack
    const verifyResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${paymentReference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
        timeout: 15000,
      }
    );
    
    const data = verifyResponse.data;
    
    if (!data.status || !data.data) {
      console.error('❌ Invalid PayStack response');
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Payment Error</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px; color: red;">
          <h1>Payment Verification Failed</h1>
          <p>Reference: ${paymentReference}</p>
          <p>You can close this window and check the app.</p>
        </body>
        </html>
      `);
    }
    
    const transactionData = data.data;
    
    // Update transaction without duplicate error
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
      console.log('⚠️ Transaction update error (non-critical):', err.message);
    }
    
    // Create HTML page with deep link for mobile AND JavaScript for web
    const deepLink = `dalabapay://payment-callback?ref=${paymentReference}&status=${transactionData.status}&amount=${transactionData.amount / 100}`;
    const webMessage = JSON.stringify({
      type: 'payment_complete',
      reference: paymentReference,
      status: transactionData.status,
      amount: transactionData.amount / 100
    });
    
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
          // For Flutter WebView
          function sendToFlutter() {
            try {
              // Try to send message to Flutter WebView
              if (window.flutter_inappwebview) {
                window.flutter_inappwebview.callHandler('paymentHandler', ${webMessage});
              }
              
              // Try to open deep link for mobile
              setTimeout(() => {
                window.location.href = '${deepLink}';
              }, 1000);
              
              // Close window after 3 seconds
              setTimeout(() => {
                window.close();
              }, 3000);
            } catch(e) {
              console.log('Error:', e);
            }
          }
          
          // Run on load
          window.onload = sendToFlutter;
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
      <head><title>Payment Error</title></head>
      <body style="font-family: Arial; text-align: center; padding: 50px; color: red;">
        <h1>Payment Error</h1>
        <p>${error.message}</p>
        <p>Please close this window and check the app.</p>
      </body>
      </html>
    `);
  }
});

// ========== POST VERIFICATION ENDPOINT (Used by Flutter) ==========
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

    // Check if already processed - use 'Successful' status
    const existing = await Transaction.findOne({
      reference,
      status: 'Successful'
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

    // Create or update transaction - handle duplicate reference
    let transaction = await Transaction.findOne({ reference: reference });
    
    if (transaction) {
      // Update existing transaction
      transaction.status = 'Successful';
      transaction.amount = amountNaira;
      transaction.gatewayResponse = data.data;
      transaction.balanceBefore = balanceBefore;
      transaction.balanceAfter = user.walletBalance;
      await transaction.save();
      console.log('✅ Updated existing transaction');
    } else {
      // Create new transaction
      transaction = await Transaction.create({
        userId,
        type: 'credit',
        amount: amountNaira,
        status: 'Successful',
        reference,
        description: `Wallet funding via PayStack - Ref: ${reference}`,
        balanceBefore,
        balanceAfter: user.walletBalance,
        gateway: 'paystack',
        metadata: { paystackData: data.data }
      });
      console.log('✅ Created new transaction');
    }

    // Sync with main backend (async)
    try {
      await axios.post(`${MAIN_BACKEND_URL}/api/wallet/top-up`, {
        userId: userId,
        amount: amountNaira,
        reference: reference,
        source: 'paystack_funding',
        description: `Wallet funding via PayStack - Ref: ${reference}`
      });
      console.log('✅ Synced with main backend');
    } catch (syncError) {
      console.error('⚠️ Sync failed:', syncError.message);
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
    
    if (error.code === 11000) {
      // Duplicate key error - try to fetch existing transaction
      try {
        const existing = await Transaction.findOne({ reference: reference });
        if (existing && existing.userId) {
          const user = await User.findById(existing.userId);
          if (user) {
            return res.json({
              success: true,
              alreadyProcessed: true,
              amount: existing.amount,
              newBalance: user.walletBalance,
              message: 'Payment already processed'
            });
          }
        }
      } catch (lookupError) {
        console.error('Lookup error:', lookupError.message);
      }
    }
    
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
      
      console.log('📩 Webhook received for:', reference);
      
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
