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

// ==================== PAYMENT INITIALIZATION ====================
router.post('/initialize', async (req, res) => {
  try {
    const { userId, email, amount, reference } = req.body;
    console.log('🚀 Initializing Paystack payment:', { userId, email, amount, reference });

    // Validate required parameters
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

    // Create pending transaction record
    await Transaction.create({
      userId,
      type: 'wallet_funding',
      amount: amount,
      reference: reference,
      status: 'pending',
      gateway: 'paystack',
      description: 'Wallet funding initialization',
      metadata: {
        source: 'payment_initialization',
        initializedAt: new Date()
      }
    });

    // Initialize PayStack payment
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: email,
        amount: amount * 100, // Convert to kobo
        reference: reference,
        callback_url: 'https://virtual-account-backend.onrender.com/api/payments/verify?redirect=true',
        metadata: { 
          userId: userId,
          timestamp: new Date().toISOString()
        },
      },
      {
        headers: { 
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` 
        },
        timeout: 15000,
      }
    );

    if (!response.data.status) {
      throw new Error('PayStack initialization failed');
    }

    console.log('✅ Payment initialized successfully:', reference);

    res.json({
      success: true,
      authorizationUrl: response.data.data.authorization_url,
      reference: response.data.data.reference,
      accessCode: response.data.data.access_code,
      message: 'Payment initialized successfully'
    });

  } catch (error) {
    console.error('❌ Initialize error:', error.response?.data || error.message);
    
    // Update transaction status to failed
    if (req.body.reference) {
      await Transaction.findOneAndUpdate(
        { reference: req.body.reference },
        { 
          status: 'failed',
          gatewayResponse: error.response?.data || { error: error.message }
        }
      );
    }

    res.status(500).json({
      success: false,
      message: 'Payment initialization failed',
      error: error.response?.data?.message || error.message
    });
  }
});

// ==================== MANUAL VERIFICATION ====================
router.post('/manual-verify', async (req, res) => {
  try {
    const { reference, userId } = req.body;
    
    if (!reference) {
      return res.status(400).json({ 
        success: false, 
        message: 'Reference is required' 
      });
    }

    console.log('🔍 Manual verification requested:', reference);

    // Use the same verification logic as GET /verify
    const verifyResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
        timeout: 15000,
      }
    );

    const data = verifyResponse.data.data;

    if (data.status === 'success') {
      const amount = data.amount / 100;
      const actualUserId = userId || extractUserId(data);

      if (!actualUserId) {
        return res.status(400).json({ 
          success: false, 
          message: 'User ID not found in transaction' 
        });
      }

      await handleSuccessfulPayment(data, reference, 'false', res);
    } else {
      res.status(400).json({
        success: false,
        message: `Payment ${data.status}`,
        status: data.status
      });
    }

  } catch (error) {
    console.error('❌ Manual verification error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Manual verification failed',
      error: error.message
    });
  }
});

// ==================== TRANSACTION RECOVERY ====================
router.post('/recover-transactions', async (req, res) => {
  try {
    const { userId, days = 30 } = req.body;
    
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    console.log(`🔄 Recovering transactions for user ${userId} from last ${days} days`);

    // Find pending transactions for this user
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const pendingTransactions = await Transaction.find({
      userId: userId,
      status: { $in: ['pending', 'processing'] },
      createdAt: { $gte: cutoffDate },
      gateway: 'paystack'
    });

    console.log(`📊 Found ${pendingTransactions.length} pending transactions to recover`);

    const recoveryResults = [];

    for (const transaction of pendingTransactions) {
      try {
        console.log(`🔍 Verifying pending transaction: ${transaction.reference}`);
        
        const verificationResponse = await axios.get(
          `https://api.paystack.co/transaction/verify/${transaction.reference}`,
          {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
            timeout: 10000,
          }
        );

        const verifiedData = verificationResponse.data.data;

        if (verifiedData.status === 'success') {
          // Update transaction status
          transaction.status = 'success';
          transaction.gatewayResponse = verifiedData;
          await transaction.save();

          // Sync with main backend
          await syncWithMainBackendWithRetry(userId, transaction.amount, transaction.reference);

          recoveryResults.push({
            reference: transaction.reference,
            success: true,
            message: 'Recovered successfully'
          });

          console.log(`✅ Recovered transaction: ${transaction.reference}`);
        } else {
          recoveryResults.push({
            reference: transaction.reference,
            success: false,
            message: `Transaction ${verifiedData.status}`
          });
        }
      } catch (error) {
        console.error(`❌ Failed to recover transaction ${transaction.reference}:`, error.message);
        recoveryResults.push({
          reference: transaction.reference,
          success: false,
          error: error.message
        });
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    res.json({
      success: true,
      recovered: recoveryResults.filter(r => r.success).length,
      failed: recoveryResults.filter(r => !r.success).length,
      details: recoveryResults,
      message: `Recovery completed: ${recoveryResults.filter(r => r.success).length} transactions recovered`
    });

  } catch (error) {
    console.error('❌ Transaction recovery error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Transaction recovery failed',
      error: error.message
    });
  }
});

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

// Enhanced sync with retry logic
async function syncWithMainBackendWithRetry(userId, amount, reference, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Syncing with main backend (Attempt ${attempt}/${maxRetries})`);
      
      const response = await axios.post(
        `${MAIN_BACKEND_URL}/api/wallet/top-up`,
        {
          userId: userId,
          amount: amount,
          reference: reference,
          type: 'credit',
          description: `Wallet funding via PayStack - Ref: ${reference}`,
          source: 'paystack_webhook',
          timestamp: new Date().toISOString()
        },
        {
          timeout: 10000,
          headers: { 'Content-Type': 'application/json' }
        }
      );

      if (response.data.success) {
        console.log('✅ Main backend sync successful');
        return true;
      } else {
        throw new Error(response.data.message || 'Main backend rejected sync');
      }
    } catch (error) {
      console.error(`❌ Sync attempt ${attempt} failed:`, error.message);
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, attempt * 2000));
    }
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

// Wallet balance endpoint
router.get('/wallet/balance/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`💰 Fetching wallet balance for user ${userId}`);

    const response = await axios.get(
      `${MAIN_BACKEND_URL}/api/users/balance/${userId}`,
      {
        timeout: 10000,
        headers: { 'Accept': 'application/json' }
      }
    );

    res.json({
      success: true,
      walletBalance: response.data.walletBalance || 0,
      userId: userId,
    });
  } catch (error) {
    console.error('❌ Wallet balance error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'Could not fetch wallet balance',
      error: error.message
    });
  }
});

// Success page
router.get('/success', (req, res) => {
  const filePath = path.join(__dirname, '../public/payment-success.html');
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error('❌ Error sending success page:', err);
      res.status(404).json({
        success: false,
        message: 'Success page not found'
      });
    }
  });
});

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Payments API is healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Test endpoint to check configuration
router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Payments API is active and properly configured',
    endpoints: [
      'GET /api/payments/verify - Payment verification',
      'POST /api/payments/initialize - Payment initialization',
      'POST /api/payments/manual-verify - Manual verification',
      'POST /api/payments/recover-transactions - Transaction recovery'
    ],
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
