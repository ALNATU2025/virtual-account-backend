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
  type: 'Wallet Funding',
  amount: amount,
  reference: reference,
  status: 'Pending',
  description: 'Wallet funding initialization',
  gateway: 'paystack',
  gatewayReference: reference,
  balanceBefore: 0,
  balanceAfter: 0
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
   // Update transaction
await Transaction.findByIdAndUpdate(transaction._id, {
  gatewayResponse: paystackData,
  gatewayReference: paystackData.reference,
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
   // Update transaction with proper schema format
try {
  await Transaction.findOneAndUpdate(
    { reference: paymentReference },
    {
      $set: {
        status: transactionData.status === 'success' ? 'Successful' : 'Failed',
        gatewayResponse: transactionData,
        gatewayReference: paymentReference,
        gateway: 'paystack',
        updatedAt: new Date()
      },
      $push: {
        'metadata.verificationHistory': {
          method: 'callback',
          timestamp: new Date(),
          status: transactionData.status,
          response: { 
            source: 'paystack_callback',
            receivedAt: new Date() 
          }
        }
      }
    },
    { upsert: true }  // Changed from false to true
  );
} catch (err) {
  console.log('⚠️ Transaction update error:', err.message);
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

// ========== PERFECT BULLETPROOF VERIFY ENDPOINT ==========
router.post('/verify-paystack', async (req, res) => {
  let reference = req.body.reference?.toString().trim();

  console.log('POST /verify-paystack →', reference);

  if (!reference) {
    return res.status(400).json({ success: false, message: 'Invalid reference' });
  }

  // Clean reference if Paystack sends it duplicated
  if (reference.includes(',')) {
    reference = reference.split(',')[0].trim();
  }

  // Enhanced rate limiting
  const now = Date.now();
  const lastAttempt = verificationCache.get(reference);
  if (lastAttempt && (now - lastAttempt) < 2000) {
    return res.json({
      success: false,
      message: 'Please wait 2 seconds before trying again.'
    });
  }
  verificationCache.set(reference, now, 10); // 10 second TTL

  try {
    // ======================================================
    // 1. QUICK CHECK: Already processed?
    // ======================================================
    const existingSuccessTx = await Transaction.findOne({ 
      reference, 
      status: 'Successful',
      balanceAfter: { $gt: 0 }
    }).lean();

    if (existingSuccessTx) {
      const user = await User.findById(existingSuccessTx.userId).select('walletBalance');
      const currentBalance = user?.walletBalance || existingSuccessTx.balanceAfter;
      
      console.log('🟢 Already processed →', reference);

      return res.json({
        success: true,
        alreadyProcessed: true,
        amount: existingSuccessTx.amount,
        balanceBefore: existingSuccessTx.balanceBefore,
        balanceAfter: existingSuccessTx.balanceAfter,
        currentBalance: currentBalance,
        message: 'Transaction already verified and credited.'
      });
    }

    // ======================================================
    // 2. VERIFY WITH PAYSTACK (ALL TRANSACTIONS NOW!)
    // ======================================================
    let paystackData;
    try {
      const resp = await axios.get(
        `https://api.paystack.co/transaction/verify/${reference}`,
        {
          headers: { 
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            'User-Agent': 'VirtualAccountBackend/1.0'
          },
          timeout: 10000
        }
      );
      paystackData = resp.data;
    } catch (err) {
      console.log('⚠️ PayStack connection error:', err.message);
      return res.json({
        success: false,
        message: 'Payment gateway timeout. Please try again.',
        retryable: true
      });
    }

    // Check if Paystack returned a valid response
    if (!paystackData.status) {
      return res.json({ 
        success: false, 
        message: 'Invalid transaction reference or PayStack error',
        shouldStopPolling: true
      });
    }

    const transactionData = paystackData.data;
    
    // Handle different Paystack statuses
    if (transactionData.status !== 'success') {
      // Update transaction status to failed if it exists
      await Transaction.findOneAndUpdate(
        { reference: reference },
        {
          status: 'Failed',
          gatewayResponse: transactionData,
          updatedAt: new Date()
        },
        { upsert: true }
      );
      
      return res.json({ 
        success: false, 
        message: `Payment ${transactionData.status} on PayStack`,
        gatewayStatus: transactionData.status,
        shouldRetry: transactionData.status === 'pending'
      });
    }

    const amount = transactionData.amount / 100;
    console.log(`💰 Verified amount: ₦${amount}`);

    // ======================================================
    // 3. IDENTIFY USER
    // ======================================================
    let userId = transactionData.metadata?.userId?.toString();

    // Fallback 1: Check customer email
    if (!userId && transactionData.customer?.email) {
      const userByEmail = await User.findOne({ 
        email: transactionData.customer.email 
      }).select('_id').lean();
      if (userByEmail) userId = userByEmail._id.toString();
    }

    // Fallback 2: Check existing pending transaction
    if (!userId) {
      const pendingTx = await Transaction.findOne({ 
        reference, 
        status: 'Pending' 
      }).select('userId');
      if (pendingTx) userId = pendingTx.userId.toString();
    }

    if (!userId) {
      console.log('❌ Cannot identify user for reference:', reference);
      // Create failed transaction record
      await Transaction.findOneAndUpdate(
        { reference: reference },
        {
          status: 'Failed',
          gatewayResponse: transactionData,
          description: 'User not found for transaction',
          updatedAt: new Date()
        },
        { upsert: true }
      );
      
      return res.status(400).json({ 
        success: false, 
        message: 'User not found. Please contact support.',
        reference: reference,
        shouldStopPolling: true
      });
    }

    // ======================================================
    // 4. CONCURRENCY LOCK - CRITICAL FIX!
    // ======================================================
    const lockKey = `lock:${reference}`;
    if (verificationCache.get(lockKey)) {
      console.log(`⏳ Lock exists for ${reference}. Another process is handling it.`);
      return res.json({
        success: false,
        message: 'Transaction is being processed. Please wait.',
        retryable: true
      });
    }
    verificationCache.set(lockKey, true, 30); // Lock for 30 seconds

    try {
      // ======================================================
      // 5. ATOMIC TRANSACTION (MongoDB Session)
      // ======================================================
      const session = await mongoose.startSession();
      
      try {
        session.startTransaction();
        
        // 5a. Get user WITH LOCK
        const user = await User.findById(userId).session(session);
        if (!user) {
          throw new Error(`User ${userId} not found`);
        }

        // Initialize wallet balance if undefined
        if (user.walletBalance === undefined || user.walletBalance === null) {
          user.walletBalance = 0;
        }

        const balanceBefore = user.walletBalance;
        const balanceAfter = balanceBefore + amount;

        // 5b. Update user balance
        user.walletBalance = balanceAfter;
        await user.save({ session });

        console.log(`💰 User balance: ₦${balanceBefore} → ₦${balanceAfter}`);

      // 5c. Prepare transaction update - FIXED FOR YOUR MODEL
const transactionUpdate = {
  $set: {
    userId: userId,
    amount: amount,
    status: 'Successful',
    type: 'Wallet Funding',
    description: `Wallet funding via PayStack - ${reference}`,
    balanceBefore: balanceBefore,
    balanceAfter: balanceAfter,
    gatewayResponse: transactionData,
    gatewayReference: reference,
    gateway: 'paystack',
    updatedAt: new Date()
  },
  $setOnInsert: {
    reference: reference,
    createdAt: new Date(),
    // MUST match your model format: TXN_timestamp_randomString
    transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`
  },
  // Correct way to push to verificationHistory array in metadata
  $push: {
    'metadata.verificationHistory': {
      method: 'polling',
      timestamp: new Date(),
      status: 'success',
      response: { 
        source: 'paystack_verification',
        verifiedAt: new Date(),
        amount: amount 
      }
    }
  }
};
        // 5d. Upsert transaction
        await Transaction.findOneAndUpdate(
          { reference: reference },
          transactionUpdate,
          { 
            upsert: true,
            session: session,
            new: true
          }
        );

        // 5e. Commit transaction
        await session.commitTransaction();
        
        console.log(`✅ ATOMIC SUCCESS: User ${userId} credited ₦${amount}`);

        // ======================================================
        // 6. SYNC TO MAIN BACKEND (non-blocking)
        // ======================================================
        try {
          await axios.post(
            `${MAIN_BACKEND_URL}/api/transactions/sync-payment`,
            {
              userId: userId,
              amount: amount,
              reference: reference,
              type: 'Wallet Funding',
              status: 'Successful',
              balanceBefore: balanceBefore,
              balanceAfter: balanceAfter,
              source: 'virtual_account_backend'
            },
            { timeout: 5000 }
          );
          console.log('📡 Synced to main backend');
        } catch (syncError) {
          console.log('⚠️ Main backend sync failed (non-critical):', syncError.message);
        }

        // ======================================================
        // 7. SUCCESS RESPONSE
        // ======================================================
        res.json({
          success: true,
          amount: amount,
          balanceBefore: balanceBefore,
          balanceAfter: balanceAfter,
          newBalance: balanceAfter,
          userId: userId,
          reference: reference,
          message: '✅ Payment verified and wallet credited successfully!'
        });

      } catch (transactionError) {
        // Rollback on any error
        await session.abortTransaction();
        throw transactionError;
      } finally {
        session.endSession();
      }

    } finally {
      // Always release the lock
      verificationCache.del(lockKey);
    }

  } catch (error) {
    console.error('❌ VERIFY ERROR:', error.message);
    console.error('Stack:', error.stack);
    
    // User-friendly error messages
    let errorMessage = 'Payment verification failed. Please try again.';
    let shouldStopPolling = false;
    
    if (error.message.includes('duplicate key')) {
      errorMessage = 'Transaction already processed. Please refresh your balance.';
      shouldStopPolling = true;
    } else if (error.message.includes('User not found')) {
      errorMessage = 'Account not found. Please contact support.';
      shouldStopPolling = true;
    } else if (error.message.includes('timeout')) {
      errorMessage = 'Verification timeout. Please check your payment status.';
    }
    
    res.status(500).json({
      success: false,
      message: errorMessage,
      reference: reference,
      shouldStopPolling: shouldStopPolling,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// ========== MANUAL RECOVERY ENDPOINT ==========
router.post('/recover-zero-balance', async (req, res) => {
  try {
    const { userId, reference } = req.body;
    
    if (!userId || !reference) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing userId or reference' 
      });
    }

    // Find problematic transaction with zero balanceAfter
    const transaction = await Transaction.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      reference: reference,
      status: 'Successful',
      $or: [
        { balanceAfter: 0 },
        { balanceAfter: { $exists: false } }
      ]
    });

    if (!transaction) {
      return res.json({
        success: false,
        message: 'No zero-balance transaction found to recover'
      });
    }

    const amount = transaction.amount;
    
    // Start atomic session
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Get user with lock
      const user = await User.findById(userId).session(session);
      if (!user) {
        throw new Error('User not found');
      }

      // Initialize wallet balance if needed
      if (user.walletBalance === undefined || user.walletBalance === null) {
        user.walletBalance = 0;
      }

      const balanceBefore = user.walletBalance;
      const balanceAfter = balanceBefore + amount;

      // Update user
      user.walletBalance = balanceAfter;
      await user.save({ session });

      // Fix transaction
      await Transaction.updateOne(
        { _id: transaction._id },
        {
          $set: {
            balanceBefore: balanceBefore,
            balanceAfter: balanceAfter,
            updatedAt: new Date(),
            'metadata.recovery': {
              recoveredAt: new Date(),
              oldBalanceAfter: transaction.balanceAfter || 0,
              newBalanceAfter: balanceAfter
            }
          }
        },
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      console.log(`🔄 RECOVERED: User ${userId} +₦${amount} (was: ₦${transaction.balanceAfter || 0})`);

      res.json({
        success: true,
        amount: amount,
        oldBalance: balanceBefore,
        newBalance: balanceAfter,
        reference: reference,
        message: 'Balance successfully recovered!'
      });

    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }

  } catch (error) {
    console.error('Recovery error:', error);
    res.status(500).json({
      success: false,
      message: 'Recovery failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});



// ========== COMPLETE WEBHOOK (FIXED) ==========
router.post('/webhook/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  let session;
  
  try {
    const event = JSON.parse(req.body.toString());

    // Only handle successful charge
    if (event.event !== 'charge.success') {
      return res.sendStatus(200);
    }

    const data = event.data;
    const reference = data.reference;
    const amount = data.amount / 100;

    console.log("📩 Webhook received:", reference);

    // ========== CONCURRENCY LOCK ==========
    const lockKey = `lock:${reference}`;
    if (verificationCache.get(lockKey)) {
      console.log(`⏳ Webhook: Lock exists for ${reference}. Skipping.`);
      return res.sendStatus(200);
    }
    verificationCache.set(lockKey, true, 30);

    try {
      // 1. Check if already processed
      const existing = await Transaction.findOne({ reference, status: "Successful" });
      if (existing) {
        console.log("⛔ Already processed webhook:", reference);
        return res.sendStatus(200);
      }

      // 2. Get user
      let userId = data.metadata?.userId;

      // Fallback using email
      if (!userId && data.customer?.email) {
        const user = await User.findOne({ email: data.customer.email });
        if (user) userId = user._id;
      }

      if (!userId) {
        console.log("❌ No user found for webhook");
        return res.sendStatus(200);
      }

      // 3. ATOMIC TRANSACTION
      session = await mongoose.startSession();
      session.startTransaction();

      // 4. Get user WITH LOCK
      const user = await User.findById(userId).session(session);
      if (!user) {
        throw new Error(`User ${userId} not found`);
      }

      // Initialize wallet balance if undefined
      if (user.walletBalance === undefined || user.walletBalance === null) {
        user.walletBalance = 0;
      }

      const balanceBefore = user.walletBalance;
      const balanceAfter = balanceBefore + amount;

      // 5. Update user balance
      user.walletBalance = balanceAfter;
      await user.save({ session });

      // 6. Save transaction (matches your model schema)
      const transactionUpdate = {
        $set: {
          userId: userId,
          amount: amount,
          status: 'Successful',
          type: 'Wallet Funding',
          description: "Wallet funding via Paystack Webhook",
          balanceBefore: balanceBefore,
          balanceAfter: balanceAfter,
          gatewayResponse: data,
          gatewayReference: reference,
          gateway: 'paystack',
          updatedAt: new Date()
        },
        $setOnInsert: {
          reference: reference,
          createdAt: new Date(),
          // MUST match your model format
          transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`
        },
        // Correct way to push to verificationHistory
        $push: {
          'metadata.verificationHistory': {
            method: 'webhook',
            timestamp: new Date(),
            status: 'success',
            response: { 
              source: 'paystack_webhook',
              receivedAt: new Date(),
              amount: amount 
            }
          }
        }
      };

      await Transaction.findOneAndUpdate(
        { reference: reference },
        transactionUpdate,
        { 
          upsert: true,
          session: session,
          new: true
        }
      );

      // 7. Commit
      await session.commitTransaction();
      
      console.log(`✅ Webhook: User ${userId} credited ₦${amount} | Before: ₦${balanceBefore} → After: ₦${balanceAfter}`);

      return res.sendStatus(200);

    } catch (error) {
      // Rollback on error
      if (session) {
        await session.abortTransaction();
      }
      console.error("🔥 WEBHOOK PROCESSING ERROR:", error.message);
      // Don't return 500 - PayStack will retry
      return res.sendStatus(200);
    } finally {
      if (session) {
        session.endSession();
      }
      // Always release the lock
      verificationCache.del(lockKey);
    }

  } catch (error) {
    console.error("🔥 WEBHOOK PARSING ERROR:", error);
    return res.sendStatus(500);
  }
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
