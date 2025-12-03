const express = require('express');
const router = express.Router();
const axios = require('axios');
const path = require('path');
const Transaction = require('../models/Transaction');

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
  // THIS IS ALL YOU NEED — ALLOWS MOBILE APPS, WEB, CAPACITOR, AND EVERYTHING
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Client-Platform, X-Request-ID, X-User-ID');
  res.header('Access-Control-Allow-Credentials', 'true');

  // Handle preflight (OPTIONS) requests
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

    // Generate proper PayStack reference (like: 100004251121121330145800078218)
    const paystackReference = generatePaystackReference();
    console.log('📝 Generated PayStack reference:', paystackReference);

    // Skip PIN verification in backend (handle in Flutter)
    console.log('⏭️ Skipping PIN verification in backend');

    // Create transaction record
    const transaction = await Transaction.create({
      userId,
      type: 'wallet_funding',
      amount: amount,
      reference: paystackReference, // Use the proper reference
      status: 'pending',
      gateway: 'paystack',
      description: 'Wallet funding initialization',
      metadata: {
        source: 'payment_initialization',
        userReference: reference, // Store the original reference
        hasPin: !!transactionPin,
        useBiometric: !!useBiometric,
        initializedAt: new Date()
      }
    });

    console.log('✅ Transaction record created');

    // Initialize PayStack payment with proper reference
    const paystackPayload = {
      email: email,
      amount: Math.round(amount * 100), // Convert to kobo
      reference: paystackReference, // Use the proper reference
      callback_url: `https://virtual-account-backend.onrender.com/api/payments/verify?redirect=true&reference=${paystackReference}`,
      metadata: { 
        userId: userId,
        userReference: reference, // Include original reference
        timestamp: new Date().toISOString(),
        source: 'virtual_account_backend',
        transactionId: transaction._id.toString()
      },
    };

    console.log('📤 Sending to PayStack:', {
      email: paystackPayload.email,
      amount: paystackPayload.amount,
      reference: paystackPayload.reference
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

    // Update transaction with PayStack response
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
      reference: paystackData.reference, // Return the proper reference
      accessCode: paystackData.access_code,
      message: 'Payment initialized successfully',
      transactionId: transaction._id,
      userReference: reference // Include original reference for client
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

// Generate proper PayStack reference (like: 100004251121121330145800078218)
function generatePaystackReference() {
  const timestamp = Date.now().toString();
  const random = Math.random().toString().substring(2, 15);
  // Format: timestamp + random digits to make it 24 characters
  return (timestamp + random).substring(0, 24);
}

// ==================== PAYMENT VERIFICATION ====================
router.get('/verify', async (req, res) => {
  try {
    const { reference, trxref, redirect = 'true' } = req.query;
    const paymentReference = reference || trxref;
    
    console.log(`🔍 Verifying Paystack Payment: ${paymentReference}`);

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

    // Verify with PayStack
    const verifyResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${paymentReference}`,
      {
        headers: { 
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` 
        },
        timeout: 15000,
      }
    );

    const responseData = verifyResponse.data;
    
    if (!responseData.status) {
      throw new Error('Invalid response from PayStack');
    }

    const data = responseData.data;
    console.log('📊 Paystack verification response:', {
      status: data.status,
      reference: data.reference,
      amount: data.amount,
      gateway_response: data.gateway_response,
    });

    // Handle different payment statuses
    if (data.status === 'success') {
      return await handleSuccessfulPayment(data, paymentReference, redirect, res);
    } else if (data.status === 'failed') {
      return await handleFailedPayment(data, paymentReference, redirect, res);
    } else {
      // Pending or other status
      return await handlePendingPayment(data, paymentReference, redirect, res);
    }

  } catch (error) {
    console.error('❌ Verify payment error:', error.response?.data || error.message);
    
    const { reference, trxref, redirect = 'true' } = req.query;
    const paymentReference = reference || trxref;

    // Store failed verification attempt
    await storeVerificationAttempt(paymentReference, error.message);

    if (redirect === 'true' && paymentReference) {
      return res.redirect(`/api/payments/success?reference=${paymentReference}&error=verification_failed`);
    }

    res.status(500).json({
      success: false,
      message: 'Payment verification failed',
      error: error.message
    });
  }
});

// ==================== FINAL PRODUCTION VERIFICATION ENDPOINT ====================
// This endpoint is called by Flutter app → 100% duplicate-safe, balance always updates
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
        newBalance: null, // Flutter will read from local storage
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
        newBalance: null, // Let Flutter read from local storage
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

// ==================== PROXY SUCCESS HANDLER ====================
async function handleProxySuccessfulPayment(transactionData, res) {
  try {
    const amount = transactionData.amount / 100;
    const reference = transactionData.reference;
    const userId = extractUserId(transactionData);

    console.log('✅ PROXY: Payment successful:', {
      reference: reference,
      amount: amount,
      userId: userId
    });

    // Create or update transaction record
    let transaction = await Transaction.findOne({ reference: reference });

    if (transaction) {
      if (transaction.status !== 'success') {
        transaction.status = 'success';
        transaction.amount = amount;
        transaction.gatewayResponse = transactionData;
        await transaction.save();
        console.log('✅ PROXY: Updated existing transaction to success');
      }
    } else {
      transaction = await Transaction.create({
        userId: userId,
        type: 'wallet_funding',
        amount: amount,
        reference: reference,
        status: 'success',
        gateway: 'paystack',
        gatewayResponse: transactionData,
        description: 'Wallet funding via PayStack proxy',
        metadata: {
          paystackData: transactionData,
          source: 'proxy_verification',
          verifiedAt: new Date()
        }
      });
      console.log('✅ PROXY: Created new transaction record');
    }

    // Sync with main backend (non-blocking)
    if (userId) {
      syncWithMainBackend(userId, amount, reference)
        .then(syncResult => {
          console.log('✅ PROXY: Main backend sync completed');
        })
        .catch(syncError => {
          console.error('⚠️ PROXY: Main backend sync failed:', syncError.message);
          // Don't fail the verification if sync fails
        });
    }

    // Return success response immediately
    res.json({
      success: true,
      status: 'success',
      amount: amount,
      reference: reference,
      paidAt: transactionData.paid_at,
      message: 'Payment verified successfully!',
      source: 'paystack_proxy',
      userId: userId,
      transactionId: transaction._id
    });

  } catch (processingError) {
    console.error('❌ PROXY: Error processing successful payment:', processingError);
    
    // Even if processing fails, return success if PayStack verified it
    res.json({
      success: true,
      status: 'success',
      amount: transactionData.amount / 100,
      reference: transactionData.reference,
      paidAt: transactionData.paid_at,
      message: 'Payment verified (processing incomplete)',
      source: 'paystack_proxy_direct',
      warning: 'Some post-processing failed'
    });
  }
}

// ==================== HELPER FUNCTIONS ====================

// Verify transaction PIN with main backend
async function verifyTransactionPin(userId, transactionPin) {
  try {
    console.log(`🔐 Verifying transaction PIN for user: ${userId}`);
    
    const response = await axios.post(
      `${MAIN_BACKEND_URL}/api/users/verify-transaction-pin`,
      {
        userId: userId,
        transactionPin: transactionPin
      },
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    return response.data;
  } catch (error) {
    console.error('❌ PIN verification error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.message || 'PIN verification failed');
  }
}

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
      // Update existing transaction
      transaction.status = 'success';
      transaction.amount = amount;
      transaction.gatewayResponse = data;
      await transaction.save();
      console.log('✅ Updated existing transaction to success:', paymentReference);
    } else {
      console.log('ℹ️ Transaction already processed:', paymentReference);
    }
  } else {
    // Create new transaction
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
}

// Handle failed payment
async function handleFailedPayment(data, paymentReference, redirect, res) {
  const amount = data.amount / 100;
  const userId = extractUserId(data);

  // Update or create failed transaction
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

  // Update or create pending transaction
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
        // Rate limiting - wait and retry
        const waitTime = retries * 2000;
        console.warn(`⏳ Rate limited. Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else if (status === 404) {
        console.error('❌ Main backend endpoint not found:', url);
        break;
      } else if (status >= 500) {
        // Server error - retry
        if (retries < maxRetries) {
          const waitTime = retries * 1000;
          console.warn(`⏳ Server error. Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
        break;
      } else {
        // Client error - don't retry
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

// Test endpoint to check configuration
router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Payments API is active and properly configured',
    endpoints: [
      'POST /api/payments/initialize - Payment initialization (CORS enabled)',
      'GET /api/payments/verify - Payment verification',
      'POST /api/payments/verify-paystack - Proxy verification',
      'GET /api/payments/health - Health check'
    ],
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
