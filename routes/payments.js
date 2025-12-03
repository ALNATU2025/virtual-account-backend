const express = require('express');
const router = express.Router();
const axios = require('axios');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'https://vtpass-backend.onrender.com';

// CRITICAL: Validate environment variables
if (!PAYSTACK_SECRET_KEY) {
  console.error('❌ PAYSTACK_SECRET_KEY missing in environment');
  process.exit(1);
}

console.log('✅ Payments API initialized with secure configuration');

// ==================== CORS MIDDLEWARE — FINAL WORKING VERSION ====================
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Client-Platform, X-Request-ID, X-User-ID');
  res.header('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  next();
});

// ==================== FIXED PAYMENT INITIALIZATION ====================
router.post('/initialize-paystack', async (req, res) => {
  console.log('🚀 INITIALIZE: Received payment request', {
    userId: req.body.userId,
    email: req.body.email,
    amount: req.body.amount,
    reference: req.body.reference,
    timestamp: new Date().toISOString()
  });

  try {
    const { userId, email, amount, reference, transactionPin, useBiometric } = req.body;

    // Basic validation
    if (!email || !amount || !reference) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required parameters: email, amount, reference' 
      });
    }

    if (amount <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Amount must be greater than 0' 
      });
    }

    // Generate proper PayStack reference
    const paystackReference = generatePaystackReference();
    console.log('📝 Generated PayStack reference:', paystackReference);

    // Skip PIN verification in backend
    console.log('⏭️ Skipping PIN verification in backend');

    // Create transaction record
    const transaction = await Transaction.create({
      userId,
      type: 'wallet_funding',
      amount: amount,
      reference: paystackReference,
      status: 'pending',
      gateway: 'paystack',
      description: 'Wallet funding initialization',
      metadata: {
        source: 'payment_initialization',
        userReference: reference,
        hasPin: !!transactionPin,
        useBiometric: !!useBiometric,
        initializedAt: new Date()
      }
    });

    console.log('✅ Transaction record created');

    // FIXED: Use a clean callback URL without duplicate params
    const callbackUrl = `https://virtual-account-backend.onrender.com/api/payments/verify?reference=${paystackReference}&redirect=true`;
    
    // Initialize PayStack payment
    const paystackPayload = {
      email: email,
      amount: Math.round(amount * 100),
      reference: paystackReference,
      callback_url: callbackUrl,
      metadata: { 
        userId: userId,
        userReference: reference,
        timestamp: new Date().toISOString(),
        source: 'virtual_account_backend',
        transactionId: transaction._id.toString()
      },
    };

    console.log('📤 Sending to PayStack:', {
      email: paystackPayload.email,
      amount: paystackPayload.amount,
      reference: paystackPayload.reference,
      callbackUrl: callbackUrl
    });

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

    console.log('📥 PayStack response received');

    if (!response.data.status) {
      throw new Error(response.data.message || 'PayStack initialization failed');
    }

    const paystackData = response.data.data;
    
    console.log('✅ PayStack initialization successful');

    // Update transaction
    await Transaction.findByIdAndUpdate(transaction._id, {
      gatewayResponse: paystackData,
      status: 'initialized',
      metadata: {
        ...transaction.metadata,
        paystackReference: paystackData.reference,
        accessCode: paystackData.access_code,
        authorizationUrl: paystackData.authorization_url,
        paystackData: paystackData
      }
    });

    // Return success response
    res.json({
      success: true,
      authorizationUrl: paystackData.authorization_url,
      reference: paystackData.reference,
      accessCode: paystackData.access_code,
      message: 'Payment initialized successfully',
      transactionId: transaction._id,
      userReference: reference
    });

  } catch (error) {
    console.error('❌ INITIALIZE ERROR:', error.message);

    let errorMessage = 'Payment initialization failed';
    
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      errorMessage = 'Payment service temporarily unavailable. Please try again.';
    } else if (error.response?.status === 401) {
      errorMessage = 'Payment authentication failed. Please contact support.';
    } else if (error.response?.data?.message) {
      errorMessage = error.response.data.message;
    }

    res.status(500).json({
      success: false,
      message: errorMessage,
      error: process.env.NODE_ENV === 'production' ? null : error.message
    });
  }
});

// Generate PayStack reference
function generatePaystackReference() {
  const timestamp = Date.now().toString();
  const random = Math.random().toString().substring(2, 15);
  return (timestamp + random).substring(0, 24);
}

// ==================== SIMPLIFIED PAYMENT VERIFICATION ====================
// This endpoint handles PayStack callback redirects
router.get('/verify', async (req, res) => {
  const { reference, trxref, redirect = 'true' } = req.query;
  
  console.log('🔄 VERIFY: Starting verification (callback from PayStack)', { 
    reference, 
    trxref,
    queryParams: req.query 
  });

  try {
    // Determine which reference to use
    let paymentReference = reference || trxref || '';
    
    // Clean up reference if needed
    if (typeof paymentReference === 'string' && paymentReference.includes(',')) {
      console.log('⚠️ Cleaning reference with comma:', paymentReference);
      paymentReference = paymentReference.split(',')[0].trim();
    }

    if (!paymentReference) {
      console.log('❌ No reference provided in callback');
      if (redirect === 'true') {
        return res.redirect(`https://your-app.com/payment-error?error=no_reference`);
      }
      return res.status(400).json({ 
        success: false, 
        message: 'Payment reference is required' 
      });
    }

    console.log('🔍 Verifying with PayStack:', paymentReference);

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
      console.error('❌ Invalid PayStack response:', data);
      throw new Error(data.message || 'Invalid response from PayStack');
    }

    const transactionData = data.data;
    console.log('📊 PayStack verification status:', transactionData.status);

    // Update transaction record
    let transaction = await Transaction.findOne({ reference: paymentReference });
    if (!transaction) {
      transaction = await Transaction.create({
        userId: transactionData.metadata?.userId,
        type: 'wallet_funding',
        amount: transactionData.amount / 100,
        reference: paymentReference,
        status: transactionData.status,
        gateway: 'paystack',
        gatewayResponse: transactionData,
        description: `Wallet funding via PayStack - ${transactionData.status}`,
        metadata: {
          paystackData: transactionData,
          source: 'paystack_callback',
          verifiedAt: new Date(),
          status: transactionData.status
        }
      });
    } else {
      transaction.status = transactionData.status;
      transaction.gatewayResponse = transactionData;
      await transaction.save();
    }

    // For mobile app: redirect to deep link
    if (redirect === 'true') {
      const status = transactionData.status === 'success' ? 'success' : 'failed';
      const amount = transactionData.amount / 100;
      
      // Redirect to your app's deep link
      const deepLink = `dalabapay://payment-callback?ref=${paymentReference}&status=${status}&amount=${amount}`;
      console.log('🔗 Redirecting to deep link:', deepLink);
      
      // Show a page that redirects to the app
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Payment Complete</title>
          <meta http-equiv="refresh" content="2;url=${deepLink}">
          <script>
            // Try to open app directly
            window.location.href = '${deepLink}';
            setTimeout(function() {
              window.location.href = '${deepLink}';
            }, 1000);
          </script>
        </head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1>Payment ${status === 'success' ? 'Successful' : 'Failed'}!</h1>
          <p>Redirecting to app...</p>
          <p>If redirect doesn't work, <a href="${deepLink}">click here</a></p>
        </body>
        </html>
      `);
    }

    // Return JSON response for direct API calls
    res.json({
      success: transactionData.status === 'success',
      status: transactionData.status,
      amount: transactionData.amount / 100,
      reference: paymentReference,
      message: `Payment ${transactionData.status === 'success' ? 'verified successfully' : transactionData.status}`,
      data: transactionData
    });

  } catch (error) {
    console.error('❌ VERIFICATION ERROR:', error.message);
    
    // Store verification attempt
    await storeVerificationAttempt(req.query.reference || req.query.trxref || '', error.message);
    
    if (req.query.redirect === 'true') {
      const errorLink = `dalabapay://payment-callback?ref=${req.query.reference || ''}&status=error&error=${encodeURIComponent(error.message)}`;
      return res.redirect(errorLink);
    }
    
    res.status(500).json({
      success: false,
      message: 'Verification failed',
      error: process.env.NODE_ENV === 'production' ? null : error.message
    });
  }
});

// ==================== MAIN VERIFICATION ENDPOINT (Used by Flutter) ====================
router.post('/verify-paystack', async (req, res) => {
  let reference = req.body.reference;

  console.log('PROXY VERIFY: Starting verification for:', reference);

  try {
    // Clean reference
    if (Array.isArray(reference)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid reference format (array)'
      });
    }

    if (typeof reference === 'string' && reference.includes(',')) {
      reference = reference.split(',')[0].trim();
      console.log('Cleaned reference:', reference);
    }

    if (!reference || reference.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Payment reference is required'
      });
    }

    reference = reference.trim();

    // STEP 1: Check if already processed in database
    const existingTransaction = await Transaction.findOne({
      reference,
      status: 'success'
    });

    if (existingTransaction) {
      console.log('✅ Already processed in database:', reference);
      
      // Get user balance
      let newBalance = null;
      if (existingTransaction.userId) {
        const user = await User.findById(existingTransaction.userId);
        if (user) {
          newBalance = user.walletBalance;
        }
      }

      return res.json({
        success: true,
        alreadyProcessed: true,
        amount: existingTransaction.amount,
        newBalance: newBalance,
        message: 'Payment already verified and credited',
        source: 'database_cache'
      });
    }

    // STEP 2: Verify with PayStack
    const paystackResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
        timeout: 15000
      }
    );

    const data = paystackResponse.data;

    if (!data.status || !data.data) {
      return res.status(400).json({
        success: false,
        message: data.message || 'Invalid PayStack response',
        reference
      });
    }

    const transactionData = data.data;
    
    if (transactionData.status !== 'success') {
      return res.json({
        success: false,
        status: transactionData.status,
        message: 'Payment not successful',
        reference
      });
    }

    // STEP 3: Process successful payment
    const amountNaira = transactionData.amount / 100;
    const userId = transactionData.metadata?.userId;

    if (!userId) {
      console.error('❌ No userId in metadata:', transactionData.metadata);
      return res.status(400).json({
        success: false,
        message: 'userId not found in payment metadata'
      });
    }

    // STEP 4: Update database atomically
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
      const user = await User.findById(userId).session(session);
      if (!user) {
        await session.abortTransaction();
        throw new Error('User not found');
      }

      const balanceBefore = user.walletBalance;
      user.walletBalance += amountNaira;
      await user.save({ session });

      // Create or update transaction
      await Transaction.findOneAndUpdate(
        { reference: reference },
        {
          userId,
          type: 'credit',
          amount: amountNaira,
          status: 'success',
          reference,
          description: `Wallet funding via PayStack - Ref: ${reference}`,
          balanceBefore,
          balanceAfter: user.walletBalance,
          gateway: 'paystack',
          gatewayResponse: transactionData,
          metadata: { 
            source: 'proxy_verification', 
            paystackData: transactionData,
            verifiedAt: new Date()
          }
        },
        { upsert: true, session }
      );

      await session.commitTransaction();
      console.log(`✅ VERIFICATION SUCCESS: +₦${amountNaira} | User: ${userId} | New Balance: ${user.walletBalance}`);

      // STEP 5: Sync with main backend (async - don't wait)
      syncWithMainBackend(userId, amountNaira, reference)
        .then(result => {
          console.log('✅ Main backend sync result:', result.message);
        })
        .catch(syncError => {
          console.error('⚠️ Main backend sync failed:', syncError.message);
        });

      // Return success response
      return res.json({
        success: true,
        amount: amountNaira,
        newBalance: user.walletBalance, // Return actual new balance
        reference: reference,
        message: 'Payment verified and wallet updated successfully',
        userId: userId
      });

    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }

  } catch (error) {
    console.error('❌ PROXY VERIFICATION ERROR:', error.message);

    if (error.response?.status === 404) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found on PayStack',
        reference: reference || 'unknown'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Verification failed',
      error: process.env.NODE_ENV === 'production' ? null : error.message,
      reference: reference || 'unknown'
    });
  }
});

// ==================== WEBHOOK HANDLER ====================
router.post('/webhook/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    console.log('📩 PAYSTACK WEBHOOK RECEIVED');
    
    const signature = req.headers['x-paystack-signature'];
    const body = req.body.toString();
    
    // Verify signature
    const crypto = require('crypto');
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(body)
      .digest('hex');
    
    if (hash !== signature) {
      console.error('❌ Invalid webhook signature');
      return res.status(400).send('Invalid signature');
    }
    
    const event = JSON.parse(body);
    console.log('📋 WEBHOOK EVENT:', event.event);
    
    if (event.event === 'charge.success') {
      const data = event.data;
      const reference = data.reference;
      const amount = data.amount / 100;
      const userId = data.metadata?.userId;
      
      console.log('✅ WEBHOOK: Payment successful', { reference, amount, userId });
      
      // Check if already processed
      const existing = await Transaction.findOne({ reference, status: 'success' });
      if (existing) {
        console.log('✅ WEBHOOK: Already processed');
        return res.sendStatus(200);
      }
      
      // Update database
      await Transaction.findOneAndUpdate(
        { reference },
        {
          userId: userId,
          type: 'credit',
          amount: amount,
          status: 'success',
          gateway: 'paystack',
          gatewayResponse: data,
          description: `Wallet funding via PayStack Webhook - Ref: ${reference}`,
          metadata: {
            paystackData: data,
            source: 'paystack_webhook',
            webhookProcessed: true,
            processedAt: new Date()
          }
        },
        { upsert: true }
      );
      
      // Update user balance if userId exists
      if (userId) {
        try {
          await User.findByIdAndUpdate(userId, {
            $inc: { walletBalance: amount }
          });
          console.log(`✅ WEBHOOK: Updated user ${userId} balance by +₦${amount}`);
        } catch (userError) {
          console.error('⚠️ WEBHOOK: Failed to update user balance:', userError.message);
        }
      }
      
      // Sync with main backend
      if (userId) {
        syncWithMainBackend(userId, amount, reference)
          .then(() => console.log('✅ WEBHOOK: Synced with main backend'))
          .catch(err => console.error('⚠️ WEBHOOK: Main backend sync failed:', err.message));
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ WEBHOOK PROCESSING ERROR:', error);
    res.status(500).send('Webhook processing failed');
  }
});

// ==================== SIMPLE SUCCESS PAGE FOR WEB ====================
router.get('/success-page', (req, res) => {
  const { reference, amount, status } = req.query;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Payment Complete</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        .success { color: green; }
        .failed { color: red; }
      </style>
      <script>
        // Send message to Flutter WebView
        function sendToFlutter() {
          const message = {
            type: 'payment_complete',
            reference: '${reference || ''}',
            status: '${status || 'unknown'}',
            amount: ${amount || 0}
          };
          if (window.flutter_inappwebview) {
            window.flutter_inappwebview.callHandler('paymentHandler', message);
          }
          // Also try to close the window
          setTimeout(() => {
            window.close();
          }, 2000);
        }
        
        // Run on load
        window.onload = sendToFlutter;
      </script>
    </head>
    <body>
      <h1 class="${status === 'success' ? 'success' : 'failed'}">
        Payment ${status === 'success' ? 'Successful' : 'Failed'}!
      </h1>
      <p>Reference: ${reference || 'N/A'}</p>
      <p>Amount: ₦${amount || 0}</p>
      <p>You can close this window.</p>
    </body>
    </html>
  `);
});

// ==================== HELPER FUNCTIONS ====================

// Sync with main backend
async function syncWithMainBackend(userId, amount, reference) {
  try {
    console.log(`🔄 Syncing with main backend: User ${userId}, Amount ${amount}`);
    
    const syncResponse = await axios.post(
      `${MAIN_BACKEND_URL}/api/wallet/top-up`,
      {
        userId: userId,
        amount: amount,
        reference: reference,
        source: 'paystack_funding',
        description: `Wallet funding via PayStack - Ref: ${reference}`,
        timestamp: new Date().toISOString()
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );

    if (syncResponse.data.success) {
      console.log('✅ Main backend sync successful');
      return { success: true, message: 'Sync completed' };
    } else {
      throw new Error(syncResponse.data.message || 'Main backend rejected sync');
    }
  } catch (error) {
    console.error('❌ Main backend sync failed:', error.message);
    
    // Store for retry later
    await storeFailedSync(userId, amount, reference, error.message);
    
    return { 
      success: false, 
      message: 'Failed to sync with main backend',
      error: error.message
    };
  }
}

// Store failed sync attempt
async function storeFailedSync(userId, amount, reference, error) {
  try {
    const FailedSync = require('../models/FailedSync');
    await FailedSync.create({
      userId: userId,
      amount: amount,
      reference: reference,
      error: error,
      retryCount: 0,
      lastAttempt: new Date()
    });
    console.log('💾 Stored failed sync for recovery');
  } catch (storageError) {
    console.error('❌ Failed to store failed sync:', storageError.message);
  }
}

// Store verification attempt
async function storeVerificationAttempt(reference, error) {
  try {
    const VerificationAttempt = require('../models/VerificationAttempt');
    await VerificationAttempt.create({
      reference: reference,
      error: error,
      attemptedAt: new Date()
    });
  } catch (storageError) {
    console.error('❌ Failed to store verification attempt:', storageError.message);
  }
}

// ==================== UTILITY ENDPOINTS ====================

// Health check
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Payments API is healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    endpoints: [
      'POST /api/payments/initialize-paystack',
      'GET /api/payments/verify',
      'POST /api/payments/verify-paystack',
      'POST /api/payments/webhook/paystack'
    ]
  });
});

// Get transaction status
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
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching status' });
  }
});

module.exports = router;
