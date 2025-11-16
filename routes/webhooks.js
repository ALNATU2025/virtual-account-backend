const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const Transaction = require('../models/Transaction');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
// CRITICAL: Check if secret key exists
if (!PAYSTACK_SECRET_KEY) {
  console.error('❌ PAYSTACK_SECRET_KEY is missing in environment variables');
  throw new Error('PAYSTACK_SECRET_KEY is required for webhooks');
}

const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'https://vtpass-backend.onrender.com';

// Circuit breaker for sync failures
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;

// Configure body parser for raw data
router.use(express.raw({ type: 'application/json' }));

// GET endpoint for testing webhook URL
router.get('/paystack', (req, res) => {
  console.log('✅ Webhook GET test received');
  res.json({
    success: true,
    message: 'PayStack webhook endpoint is active and ready',
    endpoint: 'POST /api/webhooks/paystack',
    timestamp: new Date().toISOString(),
    instructions: 'Send POST requests with PayStack webhook data to this endpoint'
  });
});

// POST endpoint for actual PayStack webhooks - FIXED VERSION
router.post('/paystack', async (req, res) => {
  console.log('📨 Webhook received from PayStack');
  
  try {
    // Verify signature for security
    const signature = req.headers['x-paystack-signature'];
    if (!signature) {
      console.log('❌ No signature found in headers');
      return res.status(401).json({ success: false, message: 'No signature provided' });
    }

    // Verify the webhook signature
    const computedHash = crypto
      .createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest('hex');

    if (computedHash !== signature) {
      console.log('❌ Invalid webhook signature');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    // Parse and validate the webhook data
    const event = JSON.parse(req.body.toString());
    
    if (!validateWebhookEvent(event)) {
      console.log('❌ Invalid webhook event structure');
      return res.status(400).json({ success: false, message: 'Invalid event structure' });
    }

    console.log('✅ Valid PayStack webhook received:', event.event);

    // IMMEDIATELY respond to Paystack to prevent retries
    res.status(200).json({ received: true });

    // Process webhook asynchronously
    processWebhookEvent(event);

  } catch (error) {
    console.error('❌ Webhook processing error:', error.message);
    // Still respond successfully to prevent Paystack retries
    res.status(200).json({ received: true });
  }
});

// Validate webhook event structure
function validateWebhookEvent(event) {
  if (!event || !event.event || !event.data) {
    console.error('Invalid webhook event structure:', event);
    return false;
  }
  
  const validEvents = ['charge.success', 'transfer.success', 'charge.failed', 'transfer.failed'];
  if (!validEvents.includes(event.event)) {
    console.log(`⚠️ Unsupported event type: ${event.event}`);
  }
  
  return true;
}

// Async webhook processing
async function processWebhookEvent(event) {
  try {
    console.log(`🔄 Processing webhook event: ${event.event}`);
    
    switch (event.event) {
      case 'charge.success':
        await handleSuccessfulCharge(event.data);
        break;
      case 'transfer.success':
        await handleSuccessfulTransfer(event.data);
        break;
      case 'charge.failed':
        await handleFailedCharge(event.data);
        break;
      case 'transfer.failed':
        await handleFailedTransfer(event.data);
        break;
      default:
        console.log(`ℹ️ Unhandled webhook event: ${event.event}`);
    }
  } catch (error) {
    console.error('❌ Error processing webhook event:', error);
  }
}

// Enhanced charge success handler
async function handleSuccessfulCharge(chargeData) {
  try {
    console.log('💰 Processing successful charge:', chargeData.reference);

    // Convert amount to Naira (Paystack amounts are in kobo)
    const amountInNaira = chargeData.amount / 100;
    const userId = extractUserIdFromChargeData(chargeData);

    if (!userId) {
      console.log('❌ No userId found, skipping wallet update');
      await storeFailedTransaction(chargeData, 'No user ID found in charge data');
      return;
    }

    // Verify with PayStack API for extra security
    const verificationResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${chargeData.reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
        timeout: 10000,
      }
    ).catch(error => {
      console.error('PayStack verification failed:', error.response?.data || error.message);
      throw new Error(`PayStack verification failed: ${error.message}`);
    });

    const verifiedData = verificationResponse.data.data;

    if (verifiedData.status !== 'success') {
      console.log('❌ Transaction not successful:', verifiedData.status);
      await handleFailedCharge(verifiedData);
      return;
    }

    // Check if transaction already exists
    let transaction = await Transaction.findOne({ reference: chargeData.reference });
    
    if (transaction) {
      if (transaction.status !== 'success') {
        // Update existing transaction
        transaction.status = 'success';
        transaction.amount = amountInNaira;
        transaction.gatewayResponse = chargeData;
        await transaction.save();
        console.log('✅ Updated existing transaction:', chargeData.reference);
      } else {
        console.log('ℹ️ Transaction already processed:', chargeData.reference);
        return;
      }
    } else {
      // Create new transaction
      transaction = await Transaction.create({
        userId,
        type: 'wallet_funding',
        amount: amountInNaira,
        reference: chargeData.reference,
        status: 'success',
        gateway: 'paystack',
        gatewayResponse: chargeData,
        description: 'Wallet funding via Paystack webhook',
        metadata: {
          paystackData: chargeData,
          source: 'paystack_webhook',
          verifiedAt: new Date()
        }
      });
      console.log('✅ New transaction recorded:', chargeData.reference);
    }

    // Sync with main backend with retry logic
    await syncWithMainBackendWithRetry(userId, amountInNaira, chargeData.reference);

    console.log('🎉 Payment processing completed for user:', userId);

  } catch (error) {
    console.error('❌ Error processing charge:', error.message);
    
    // Store failed transaction for later recovery
    await storeFailedTransaction(chargeData, error.message);
  }
}

// Extract user ID from charge data
function extractUserIdFromChargeData(chargeData) {
  return chargeData.metadata?.userId || 
         chargeData.metadata?.custom_fields?.find(f => f.variable_name === 'user_id')?.value ||
         chargeData.customer?.metadata?.userId ||
         chargeData.metadata?.user_id ||
         chargeData.customer?.email;
}

// Enhanced sync with main backend - FIXED VERSION
async function syncWithMainBackendWithRetry(userId, amount, reference, maxRetries = 3) {
  // Check circuit breaker
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    throw new Error('Circuit breaker open - too many consecutive sync failures');
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Syncing with main backend (Attempt ${attempt}/${maxRetries}) for user: ${userId}`);
      
      const syncPayload = {
        userId: userId,
        amount: amount, // Amount in Naira
        reference: reference,
        description: `Wallet funding via PayStack - Ref: ${reference}`,
        source: 'paystack_webhook',
        timestamp: new Date().toISOString()
      };

      console.log('📦 Sync payload:', { ...syncPayload, amount: `${amount} Naira` });

      const response = await axios.post(
        `${MAIN_BACKEND_URL}/api/wallet/top-up`,
        syncPayload,
        {
          timeout: 15000,
          headers: { 
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('✅ Main backend sync successful');
      consecutiveFailures = 0; // Reset circuit breaker on success

      if (response.data.success) {
        return {
          success: true,
          data: response.data
        };
      } else {
        throw new Error(response.data.message || 'Main backend rejected sync');
      }
    } catch (error) {
      consecutiveFailures++;
      console.error(`❌ Sync attempt ${attempt} failed:`, error.message);
      
      if (attempt === maxRetries) {
        const finalError = `All sync attempts failed. Last error: ${error.message}`;
        console.error(finalError);
        throw new Error(finalError);
      }
      
      // Exponential backoff
      const delay = Math.min(attempt * 2000, 10000);
      console.log(`⏳ Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Handle failed charges
async function handleFailedCharge(chargeData) {
  try {
    console.log('❌ Processing failed charge:', chargeData.reference);
    
    const userId = extractUserIdFromChargeData(chargeData);
    if (!userId) {
      console.log('❌ No userId found for failed charge');
      return;
    }

    // Update or create failed transaction
    let transaction = await Transaction.findOne({ reference: chargeData.reference });
    
    if (transaction) {
      transaction.status = 'failed';
      transaction.gatewayResponse = chargeData;
      await transaction.save();
      console.log('✅ Updated existing transaction to failed:', chargeData.reference);
    } else {
      await Transaction.create({
        userId,
        type: 'wallet_funding',
        amount: chargeData.amount / 100,
        reference: chargeData.reference,
        status: 'failed',
        gateway: 'paystack',
        gatewayResponse: chargeData,
        description: 'Failed wallet funding via Paystack',
        metadata: {
          paystackData: chargeData,
          source: 'paystack_webhook',
          failedAt: new Date(),
          failureReason: chargeData.gateway_response || 'Unknown error'
        }
      });
      console.log('✅ New failed transaction recorded:', chargeData.reference);
    }

  } catch (error) {
    console.error('❌ Error processing failed charge:', error.message);
  }
}

// Handle failed transfers
async function handleFailedTransfer(transferData) {
  try {
    console.log('❌ Processing failed transfer:', transferData.reference);
    // Add your failed transfer logic here
  } catch (error) {
    console.error('❌ Error processing failed transfer:', error.message);
  }
}

// Handle successful transfers (for virtual accounts)
async function handleSuccessfulTransfer(transferData) {
  try {
    console.log('💳 Processing successful transfer:', transferData.reference);
    
    // Add your virtual account transfer logic here
    // This would handle when money is transferred to your virtual account
    
  } catch (error) {
    console.error('❌ Error processing transfer:', error.message);
  }
}

// Store failed transactions for recovery
async function storeFailedTransaction(chargeData, error) {
  try {
    const FailedTransaction = require('../models/FailedTransaction');
    
    await FailedTransaction.create({
      reference: chargeData.reference,
      chargeData: chargeData,
      error: error,
      attemptCount: 0,
      lastAttempt: new Date(),
      userId: extractUserIdFromChargeData(chargeData)
    });
    
    console.log('💾 Stored failed transaction for recovery:', chargeData.reference);
  } catch (storageError) {
    console.error('❌ Failed to store failed transaction:', storageError.message);
  }
}

// Manual verification endpoint for old transactions
router.post('/manual-verify', async (req, res) => {
  try {
    const { reference, userId, userEmail } = req.body;
    
    if (!reference) {
      return res.status(400).json({ success: false, message: 'Reference is required' });
    }

    console.log('🔍 Manual verification requested:', reference);

    // Verify with PayStack
    const verificationResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
        timeout: 10000,
      }
    ).catch(error => {
      throw new Error(`PayStack verification failed: ${error.response?.data?.message || error.message}`);
    });

    const verifiedData = verificationResponse.data.data;

    if (verifiedData.status !== 'success') {
      return res.status(400).json({ 
        success: false, 
        message: `Transaction ${verifiedData.status}`,
        status: verifiedData.status
      });
    }

    const amountInNaira = verifiedData.amount / 100;
    
    // Get the actual user ID
    let actualUserId = userId;
    if (!actualUserId && userEmail) {
      try {
        const userResponse = await axios.get(`${MAIN_BACKEND_URL}/api/users/find-by-email/${encodeURIComponent(userEmail)}`);
        if (userResponse.data.success) {
          actualUserId = userResponse.data.user._id;
          console.log('✅ Found user ID by email:', actualUserId);
        }
      } catch (error) {
        console.error('Error fetching user by email:', error.message);
      }
    }

    if (!actualUserId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID not found. Please provide userId or userEmail.' 
      });
    }

    // Process the transaction with correct user ID
    await handleSuccessfulCharge({
      ...verifiedData,
      metadata: {
        ...verifiedData.metadata,
        userId: actualUserId
      }
    });

    res.json({
      success: true,
      message: 'Transaction verified and processed successfully',
      amount: amountInNaira,
      reference: reference,
      userId: actualUserId
    });

  } catch (error) {
    console.error('❌ Manual verification error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Manual verification failed',
      error: error.message
    });
  }
});

// Recovery endpoint for old transactions
router.post('/recover-transactions', async (req, res) => {
  try {
    const { userId, days = 30 } = req.body;
    
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    console.log(`🔄 Recovering transactions for user ${userId} from last ${days} days`);

    // Find pending or failed transactions for this user
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const pendingTransactions = await Transaction.find({
      userId: userId,
      status: { $in: ['pending', 'processing', 'failed'] },
      createdAt: { $gte: cutoffDate },
      gateway: 'paystack'
    });

    console.log(`📊 Found ${pendingTransactions.length} transactions to recover`);

    const recoveryResults = [];

    for (const transaction of pendingTransactions) {
      try {
        console.log(`🔍 Verifying transaction: ${transaction.reference}`);
        
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

// Test endpoint to check webhook configuration
router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Webhook endpoint is active and properly configured',
    webhook_url: 'https://virtual-account-backend.onrender.com/api/webhooks/paystack',
    endpoints: [
      'GET /api/webhooks/paystack - Test endpoint',
      'POST /api/webhooks/paystack - PayStack webhook endpoint',
      'POST /api/webhooks/manual-verify - Manual verification',
      'POST /api/webhooks/recover-transactions - Transaction recovery',
      'GET /api/webhooks/health - Health check'
    ],
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
    consecutiveFailures,
    circuitBreaker: consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? 'OPEN' : 'CLOSED'
  });
});

// Health check endpoint
router.get('/health', (req, res) => {
  const health = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    paystackKey: !!PAYSTACK_SECRET_KEY,
    mainBackend: MAIN_BACKEND_URL,
    consecutiveFailures,
    circuitBreaker: consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? 'OPEN' : 'CLOSED'
  };
  res.json(health);
});

module.exports = router;
