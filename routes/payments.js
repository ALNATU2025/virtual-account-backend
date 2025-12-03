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

    // FIXED: Remove duplicate reference parameter in callback URL
    const callbackUrl = `https://virtual-account-backend.onrender.com/api/payments/verify?redirect=true&reference=${paystackReference}`;
    
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

// ==================== PAYMENT VERIFICATION ====================
router.get('/verify', async (req, res) => {
  let { reference, trxref, redirect = 'true' } = req.query;
  
  console.log('🔄 VERIFY: Starting verification', { reference, trxref, redirect });

  try {
    // Clean PayStack's duplicate reference bug
    let paymentReference = reference || trxref || '';
    
    if (typeof paymentReference === 'string' && paymentReference.includes(',')) {
      console.log('PAYSTACK DOUBLE REF BUG DETECTED:', paymentReference);
      paymentReference = paymentReference.split(',')[0].trim();
      console.log('CLEANED TO SINGLE REF:', paymentReference);
    }

    if (!paymentReference) {
      console.log('❌ No reference provided');
      if (redirect === 'true') {
        return res.redirect('/api/payments/success?error=no_reference');
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
    
    if (!data.status) {
      throw new Error(data.message || 'Invalid response from PayStack');
    }

    const transactionData = data.data;
    
    console.log('📊 PayStack response status:', transactionData.status);

    if (transactionData.status === 'success') {
      return await handleSuccessfulPayment(transactionData, paymentReference, redirect, res);
    } else if (transactionData.status === 'failed') {
      return await handleFailedPayment(transactionData, paymentReference, redirect, res);
    } else {
      return await handlePendingPayment(transactionData, paymentReference, redirect, res);
    }

  } catch (error) {
    console.error('❌ VERIFICATION ERROR:', error.message);
    
    // FIXED: Use the query parameters instead of undefined variables
    const ref = req.query.reference || req.query.trxref || '';
    await storeVerificationAttempt(ref, error.message);
    
    if (req.query.redirect === 'true') {
      return res.redirect(`/api/payments/success?error=verification_failed&message=${encodeURIComponent(error.message)}`);
    }
    
    res.status(500).json({
      success: false,
      message: 'Verification failed',
      error: process.env.NODE_ENV === 'production' ? null : error.message
    });
  }
});

// ==================== FINAL PRODUCTION VERIFICATION ENDPOINT ====================
router.post('/verify-paystack', async (req, res) => {
  let reference = req.body.reference;

  console.log('PROXY: Starting PayStack verification for:', reference);

  // === FIX 1: REJECT ARRAY OR COMMA-SEPARATED REFERENCES ===
  if (Array.isArray(reference)) {
    console.log('BLOCKED: Reference is array');
    return res.status(400).json({
      success: false,
      message: 'Invalid reference format (array)',
      received: reference
    });
  }

  if (typeof reference === 'string' && reference.includes(',')) {
    reference = reference.split(',')[0].trim();
    console.log('CLEANED comma-separated reference →', reference);
  }

  if (!reference || reference.trim() === '') {
    return res.status(400).json({
      success: false,
      message: 'Payment reference is required'
    });
  }

  reference = reference.trim();

  try {
    // === STEP 1: DATABASE CHECK (BLOCK DUPLICATES) ===
    const existing = await Transaction.findOne({
      reference,
      status: 'success'
    });

    if (existing) {
      console.log('DATABASE: Already processed →', reference);
      return res.json({
        success: true,
        alreadyProcessed: true,
        amount: existing.amount,
        newBalance: null,
        message: 'Payment already verified and credited',
        source: 'database'
      });
    }

    // === STEP 2: VERIFY WITH PAYSTACK ===
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

    // === SUCCESS: PROCESS PAYMENT ===
    const amountNaira = data.data.amount / 100;
    const userId = data.data.metadata?.userId;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'userId not found in metadata'
      });
    }

    // === STEP 3: UPDATE DATABASE (ATOMIC) ===
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const user = await User.findById(userId).session(session);
        if (!user) throw new Error('User not found');

        const balanceBefore = user.walletBalance;
        user.walletBalance += amountNaira;
        await user.save({ session });

        await Transaction.create([{
          userId,
          type: 'credit',
          amount: amountNaira,
          status: 'success',
          reference,
          description: `Wallet funding via PayStack - Ref: ${reference}`,
          balanceBefore,
          balanceAfter: user.walletBalance,
          gateway: 'paystack',
          metadata: { source: 'proxy_verification', paystackData: data.data }
        }], { session });
      });

      console.log(`PROXY SUCCESS: +₦${amountNaira} | Ref: ${reference} | User: ${userId}`);

      return res.json({
        success: true,
        amount: amountNaira,
        newBalance: null,
        message: 'Payment verified and wallet updated',
        transactionId: null
      });

    } finally {
      session.endSession();
    }

  } catch (error) {
    console.error('PROXY ERROR:', error.message);

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
      error: process.env.NODE_ENV === 'production' ? null : error.message
    });
  }
});

// ==================== WEBHOOK HANDLER ====================
// PayStack webhook for real-time payment notifications
router.post('/webhook/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    console.log('PAYSTACK WEBHOOK RECEIVED');
    
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
    console.log('WEBHOOK EVENT:', event.event);
    
    if (event.event === 'charge.success') {
      const data = event.data;
      const reference = data.reference;
      const amount = data.amount / 100;
      const userId = data.metadata?.userId;
      
      console.log('✅ WEBHOOK: Payment successful', {
        reference,
        amount,
        userId
      });
      
      // Check if already processed
      const existing = await Transaction.findOne({
        reference,
        status: 'success'
      });
      
      if (existing) {
        console.log('✅ WEBHOOK: Already processed');
        return res.sendStatus(200);
      }
      
      // Update transaction
      await Transaction.findOneAndUpdate(
        { reference },
        {
          status: 'success',
          gatewayResponse: data,
          metadata: {
            ...data.metadata,
            webhookProcessed: true,
            webhookTime: new Date()
          }
        },
        { upsert: true, new: true }
      );
      
      // Sync with main backend
      if (userId) {
        try {
          await axios.post(`${MAIN_BACKEND_URL}/api/wallet/top-up`, {
            userId,
            amount,
            reference,
            source: 'paystack_webhook',
            description: `Wallet funding via PayStack Webhook - Ref: ${reference}`
          });
          console.log('✅ WEBHOOK: Synced with main backend');
        } catch (syncError) {
          console.error('⚠️ WEBHOOK: Sync failed:', syncError.message);
        }
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ WEBHOOK ERROR:', error);
    res.status(500).send('Webhook processing failed');
  }
});

// ==================== PAYMENT SUCCESS REDIRECT HANDLER ====================
router.get('/success', async (req, res) => {
  const { reference, error, status, amount } = req.query;
  
  console.log('SUCCESS REDIRECT: PayStack redirected to success page', {
    reference,
    error,
    status,
    amount,
    fullUrl: req.url
  });

  if (error || status === 'failed') {
    console.log('❌ Redirect to failure page:', error);
    return res.redirect(`/api/payments/failure?reference=${reference || ''}&error=${error || 'unknown'}`);
  }

  // SUCCESS: Extract clean reference
  let cleanRef = reference?.toString() || '';
  if (cleanRef.includes(',')) {
    cleanRef = cleanRef.split(',')[0].trim();
  }

  // Verify the transaction in background
  verifyPaymentInBackground(cleanRef).catch(err => {
    console.error('Background verification failed:', err);
  });

  // Show success page
  if (req.headers['user-agent']?.includes('Flutter') || req.query.platform === 'mobile') {
    const mobileRedirect = `dalabapay://payment-success?ref=${cleanRef}&amount=${amount || 0}`;
    return res.redirect(mobileRedirect);
  }

  // Web fallback
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Payment Successful</title>
      <meta http-equiv="refresh" content="3;url=dalabapay://payment-success?ref=${cleanRef}&amount=${amount || 0}">
    </head>
    <body style="font-family: Arial; text-align: center; padding: 50px;">
      <h1>✅ Payment Successful!</h1>
      <p>Reference: <strong>${cleanRef}</strong></p>
      <p>Amount: ₦${amount || '0'}</p>
      <p>Redirecting to app...</p>
      <script>
        setTimeout(() => { 
          window.location.href = 'dalabapay://payment-success?ref=${cleanRef}&amount=${amount || 0}';
        }, 2000);
      </script>
    </body>
    </html>
  `);
});

// ==================== PAYMENT FAILURE REDIRECT HANDLER ====================
router.get('/failure', async (req, res) => {
  const { reference, error } = req.query;
  
  console.log('FAILURE REDIRECT: Payment failed', { reference, error });

  if (req.headers['user-agent']?.includes('Flutter') || req.query.platform === 'mobile') {
    const mobileRedirect = `dalabapay://payment-failed?ref=${reference || ''}&error=${error || 'unknown'}`;
    return res.redirect(mobileRedirect);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Payment Failed</title></head>
    <body style="font-family: Arial; text-align: center; padding: 50px; color: red;">
      <h1>❌ Payment Failed</h1>
      <p>Error: ${error || 'Unknown'}</p>
      <p>Reference: <strong>${reference || 'N/A'}</strong></p>
      <script>setTimeout(() => { window.close(); }, 3000);</script>
    </body>
    </html>
  `);
});

// ==================== BACKGROUND VERIFICATION HELPER ====================
async function verifyPaymentInBackground(reference) {
  try {
    console.log('🔍 Background verification for:', reference);
    
    const existing = await Transaction.findOne({ reference, status: 'success' });
    if (existing) {
      console.log('✅ Already verified:', reference);
      return;
    }
    
    const verifyResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
        timeout: 10000
      }
    );
    
    if (verifyResponse.data.data?.status === 'success') {
      console.log('✅ Background verification completed:', reference);
      
      // Update transaction
      const transaction = await Transaction.findOne({ reference });
      if (transaction && transaction.status !== 'success') {
        transaction.status = 'success';
        transaction.gatewayResponse = verifyResponse.data.data;
        await transaction.save();
        console.log('✅ Updated transaction to success');
      }
    }
  } catch (err) {
    console.error('⚠️ Background verification failed:', err.message);
  }
}

// ==================== HELPER FUNCTIONS ====================

// Handle successful payment
async function handleSuccessfulPayment(data, paymentReference, redirect, res) {
  const amount = data.amount / 100;
  const userId = extractUserId(data);

  if (!userId) {
    console.log('❌ No userId found in transaction metadata');
    if (redirect === 'true') {
      return res.redirect(`/api/payments/success?reference=${paymentReference}&error=no_user_id`);
    }
    return res.status(400).json({ 
      success: false, 
      message: 'User ID not found in transaction' 
    });
  }

  // Check if transaction already exists
  let transaction = await Transaction.findOne({ reference: paymentReference });
  
  if (transaction) {
    if (transaction.status !== 'success') {
      transaction.status = 'success';
      transaction.amount = amount;
      transaction.gatewayResponse = data;
      await transaction.save();
      console.log('✅ Updated existing transaction to success:', paymentReference);
    } else {
      console.log('ℹ️ Transaction already processed:', paymentReference);
    }
  } else {
    transaction = await Transaction.create({
      userId,
      type: 'wallet_funding',
      amount: amount,
      reference: paymentReference,
      status: 'success',
      gateway: 'paystack',
      gatewayResponse: data,
      description: 'Wallet funding via Paystack',
      metadata: {
        paystackData: data,
        source: 'payment_verification',
        verifiedAt: new Date()
      }
    });
    console.log('✅ New transaction recorded:', paymentReference);
  }

  // Sync with main backend
  try {
    const syncResult = await syncWithMainBackend(userId, amount, paymentReference);
    
    if (redirect === 'true') {
      return res.redirect(`/api/payments/success?reference=${paymentReference}&amount=${amount}&status=success`);
    }

    res.json({
      success: true,
      message: 'Payment verified successfully',
      amount: amount,
      reference: paymentReference,
      newBalance: syncResult.newBalance,
      transactionId: transaction._id,
      userId: userId
    });
  } catch (syncError) {
    console.error('❌ Sync error:', syncError.message);
    
    if (redirect === 'true') {
      return res.redirect(`/api/payments/success?reference=${paymentReference}&amount=${amount}&status=success&sync=failed`);
    }
    
    res.json({
      success: true,
      message: 'Payment verified but sync failed',
      amount: amount,
      reference: paymentReference,
      warning: 'Wallet update may be delayed',
      transactionId: transaction._id
    });
  }
}

// Handle failed payment
async function handleFailedPayment(data, paymentReference, redirect, res) {
  const amount = data.amount / 100;
  const userId = extractUserId(data);

  let transaction = await Transaction.findOne({ reference: paymentReference });
  
  if (transaction) {
    transaction.status = 'failed';
    transaction.gatewayResponse = data;
    await transaction.save();
  } else if (userId) {
    transaction = await Transaction.create({
      userId,
      type: 'wallet_funding',
      amount: amount,
      reference: paymentReference,
      status: 'failed',
      gateway: 'paystack',
      gatewayResponse: data,
      description: 'Failed wallet funding via Paystack',
      metadata: {
        paystackData: data,
        source: 'payment_verification',
        failedAt: new Date()
      }
    });
  }

  console.log('❌ Payment failed:', paymentReference);

  if (redirect === 'true') {
    return res.redirect(`/api/payments/success?reference=${paymentReference}&status=failed`);
  }

  res.status(400).json({
    success: false,
    message: 'Payment failed',
    status: 'failed',
    reference: paymentReference
  });
}

// Handle pending payment
async function handlePendingPayment(data, paymentReference, redirect, res) {
  const amount = data.amount / 100;
  const userId = extractUserId(data);

  let transaction = await Transaction.findOne({ reference: paymentReference });
  
  if (transaction) {
    transaction.status = 'pending';
    transaction.gatewayResponse = data;
    await transaction.save();
  } else if (userId) {
    transaction = await Transaction.create({
      userId,
      type: 'wallet_funding',
      amount: amount,
      reference: paymentReference,
      status: 'pending',
      gateway: 'paystack',
      gatewayResponse: data,
      description: 'Pending wallet funding via Paystack',
      metadata: {
        paystackData: data,
        source: 'payment_verification'
      }
    });
  }

  console.log('⏳ Payment pending:', paymentReference);

  if (redirect === 'true') {
    return res.redirect(`/api/payments/success?reference=${paymentReference}&status=pending`);
  }

  res.json({
    success: true,
    message: 'Payment is pending',
    status: 'pending',
    reference: paymentReference
  });
}

// Extract user ID from PayStack data
function extractUserId(data) {
  return data.metadata?.userId || 
         data.metadata?.custom_fields?.find(field => field.variable_name === 'user_id')?.value ||
         data.customer?.metadata?.userId ||
         data.customer?.email;
}

// Enhanced sync with main backend
async function syncWithMainBackend(userId, amount, reference) {
  let retries = 0;
  const maxRetries = 3;
  const url = `${MAIN_BACKEND_URL}/api/wallet/top-up`;

  while (retries < maxRetries) {
    try {
      console.log(`🔄 Syncing payment → Main Backend (Attempt ${retries + 1}/${maxRetries})`);

      const syncResponse = await axios.post(
        url,
        {
          userId: userId,
          amount: amount,
          reference: reference,
          source: 'paystack_funding',
          description: `Wallet funding via PayStack - Ref: ${reference}`,
          timestamp: new Date().toISOString()
        },
        {
          headers: { 
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 10000,
        }
      );

      if (syncResponse.data.success) {
        console.log('✅ Main backend sync successful');
        return { 
          success: true, 
          newBalance: syncResponse.data.newBalance || 0,
          message: 'Sync completed successfully'
        };
      } else {
        throw new Error(syncResponse.data.message || 'Main backend rejected sync');
      }
    } catch (error) {
      retries++;
      const status = error.response?.status;
      const errorMessage = error.response?.data?.message || error.message;

      console.error(`❌ Sync attempt ${retries} failed:`, errorMessage);

      if (status === 429) {
        const waitTime = retries * 2000;
        console.warn(`⏳ Rate limited. Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else if (status === 404) {
        console.error('❌ Main backend endpoint not found:', url);
        break;
      } else if (status >= 500) {
        if (retries < maxRetries) {
          const waitTime = retries * 1000;
          console.warn(`⏳ Server error. Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
        break;
      } else {
        break;
      }
    }
  }

  // Store failed sync for later recovery
  await storeFailedSync(userId, amount, reference, 'All sync attempts failed');
  
  return { 
    success: false, 
    newBalance: 0,
    message: 'Failed to sync with main backend after all retries'
  };
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
    
    console.log('💾 Stored failed sync for recovery:', reference);
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
    
    console.log('📝 Stored verification attempt:', reference);
  } catch (storageError) {
    console.error('❌ Failed to store verification attempt:', storageError.message);
  }
}

// ==================== UTILITY ENDPOINTS ====================

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Payments API is healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    cors: 'enabled'
  });
});

// Test endpoint
router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Payments API is active',
    endpoints: [
      'POST /api/payments/initialize-paystack - Payment initialization',
      'GET /api/payments/verify - Payment verification',
      'POST /api/payments/verify-paystack - Proxy verification',
      'POST /api/payments/webhook/paystack - Webhook handler',
      'GET /api/payments/health - Health check'
    ],
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
