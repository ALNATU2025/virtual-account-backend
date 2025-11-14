const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const Transaction = require('../models/Transaction');
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'https://vtpass-backend.onrender.com';

const bodyParser = require('body-parser');

// Enhanced webhook handler with better transaction recovery
router.post('/paystack', bodyParser.raw({ type: '*/*' }), async (req, res) => {
  let event;
  
  try {
    const signature = req.headers['x-paystack-signature'];
    const computedHash = crypto
      .createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest('hex');

    if (computedHash !== signature) {
      console.log('❌ Invalid webhook signature');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    event = JSON.parse(req.body.toString());
    console.log('✅ Valid PayStack webhook received:', event.event);

    // Immediate response to PayStack
    res.json({ success: true, message: 'Webhook received' });

    // Process webhook asynchronously
    processWebhookEvent(event);

  } catch (error) {
    console.error('❌ Webhook processing error:', error.message);
    res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
});

// Async webhook processing
async function processWebhookEvent(event) {
  try {
    if (event.event === 'charge.success') {
      await handleSuccessfulCharge(event.data);
    } else if (event.event === 'transfer.success') {
      await handleSuccessfulTransfer(event.data);
    } else if (event.event === 'charge.failed') {
      await handleFailedCharge(event.data);
    } else {
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

    const amountInNaira = chargeData.amount / 100;
    const userId = chargeData.metadata?.userId || 
                   chargeData.metadata?.custom_fields?.find(f => f.variable_name === 'user_id')?.value ||
                   chargeData.customer?.metadata?.userId;

    if (!userId) {
      console.log('❌ No userId found, skipping wallet update');
      return;
    }

    // Verify with PayStack API for extra security
    const verificationResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${chargeData.reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
        timeout: 10000,
      }
    );

    const verifiedData = verificationResponse.data.data;

    if (verifiedData.status !== 'success') {
      console.log('❌ Transaction not successful:', verifiedData.status);
      return;
    }

    // Check if transaction already exists
    let transaction = await Transaction.findOne({ reference: chargeData.reference });
    
    if (transaction) {
      if (transaction.status !== 'success') {
        // Update existing transaction
        transaction.status = 'success';
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
        description: 'Wallet funding via Paystack',
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

// Enhanced sync with retry logic
async function syncWithMainBackendWithRetry(userId, amount, reference, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Syncing with main backend (Attempt ${attempt}/${maxRetries})`);
      
      const response = await axios.post(
        `${MAIN_BACKEND_URL}/api/wallet/top-up`,
        {
          userId,
          amount,
          reference,
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

// Handle failed charges
async function handleFailedCharge(chargeData) {
  try {
    console.log('❌ Processing failed charge:', chargeData.reference);
    
    const userId = chargeData.metadata?.userId;
    if (!userId) return;

    // Update or create failed transaction
    let transaction = await Transaction.findOne({ reference: chargeData.reference });
    
    if (transaction) {
      transaction.status = 'failed';
      transaction.gatewayResponse = chargeData;
      await transaction.save();
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
          failedAt: new Date()
        }
      });
    }

    console.log('✅ Failed transaction recorded:', chargeData.reference);
  } catch (error) {
    console.error('❌ Error processing failed charge:', error.message);
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
      lastAttempt: new Date()
    });
    
    console.log('💾 Stored failed transaction for recovery:', chargeData.reference);
  } catch (storageError) {
    console.error('❌ Failed to store failed transaction:', storageError.message);
  }
}

// Manual verification endpoint for old transactions
router.post('/manual-verify', async (req, res) => {
  try {
    const { reference, userId } = req.body;
    
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
    );

    const verifiedData = verificationResponse.data.data;

    if (verifiedData.status !== 'success') {
      return res.status(400).json({ 
        success: false, 
        message: `Transaction ${verifiedData.status}`,
        status: verifiedData.status
      });
    }

    const amount = verifiedData.amount / 100;
    const actualUserId = userId || verifiedData.metadata?.userId;

    if (!actualUserId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID not found in transaction' 
      });
    }

    // Process the transaction
    await handleSuccessfulCharge(verifiedData);

    res.json({
      success: true,
      message: 'Transaction verified and processed successfully',
      amount: amount,
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

router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Webhook endpoint active',
    webhook_url: 'https://virtual-account-backend.onrender.com/api/webhooks/paystack',
    endpoints: [
      'POST /api/webhooks/paystack',
      'POST /api/webhooks/manual-verify',
      'POST /api/webhooks/recover-transactions'
    ]
  });
});

async function handleSuccessfulTransfer(transferData) {
  console.log('💳 Transfer successful:', transferData.reference);
  // Add your virtual account transfer logic here
}

module.exports = router;
