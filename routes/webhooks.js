// In your webhooks.js - COMPLETE FIXED VERSION
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'https://vtpass-backend.onrender.com';

// CRITICAL FIX: Create separate raw body parser for webhooks only
const paystackWebhookParser = (req, res, next) => {
  if (req.originalUrl.includes('/paystack')) {
    console.log('📨 Processing PayStack webhook with raw body...');
    
    let data = '';
    req.setEncoding('utf8');
    
    req.on('data', (chunk) => {
      data += chunk;
    });
    
    req.on('end', () => {
      try {
        req.rawBody = data;
        req.body = JSON.parse(data);
        console.log('✅ Raw body captured successfully');
        next();
      } catch (error) {
        console.log('❌ Error parsing raw body:', error.message);
        res.status(400).json({ success: false, message: 'Invalid JSON' });
      }
    });
  } else {
    next();
  }
};

// Apply the custom parser to webhook routes
router.use(paystackWebhookParser);

// POST endpoint for PayStack webhooks - FIXED VERSION
router.post('/paystack', async (req, res) => {
  console.log('📨 Webhook received from PayStack');
  console.log('🔍 Headers:', {
    signature: req.headers['x-paystack-signature'],
    contentType: req.headers['content-type'],
    contentLength: req.headers['content-length']
  });

  try {
    const signature = req.headers['x-paystack-signature'];
    if (!signature) {
      console.log('❌ No signature found in headers');
      return res.status(401).json({ success: false, message: 'No signature provided' });
    }

    // Use the rawBody from our custom parser
    if (!req.rawBody) {
      console.log('❌ No raw body available after parsing');
      console.log('🔍 Available data:', {
        body: req.body,
        rawBody: req.rawBody,
        bodyType: typeof req.body
      });
      return res.status(400).json({ success: false, message: 'No request body' });
    }

    console.log('📝 Raw body length:', req.rawBody.length);
    console.log('📝 Raw body sample:', req.rawBody.substring(0, 200) + '...');

    // Verify signature
    const computedHash = crypto
      .createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(req.rawBody)
      .digest('hex');

    console.log('🔐 Signature verification:', {
      computed: computedHash.substring(0, 20) + '...',
      received: signature.substring(0, 20) + '...',
      match: computedHash === signature
    });

    if (computedHash !== signature) {
      console.log('❌ Invalid webhook signature');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    // Parse the webhook data
    let event;
    try {
      event = JSON.parse(req.rawBody);
      console.log('✅ Webhook event parsed:', event.event);
    } catch (parseError) {
      console.log('❌ Failed to parse webhook body:', parseError.message);
      return res.status(400).json({ success: false, message: 'Invalid JSON' });
    }

    if (!validateWebhookEvent(event)) {
      console.log('❌ Invalid webhook event structure');
      return res.status(400).json({ success: false, message: 'Invalid event structure' });
    }

    console.log('✅ Valid PayStack webhook received:', event.event);
    console.log('📊 Event data:', {
      reference: event.data?.reference,
      amount: event.data?.amount,
      status: event.data?.status,
      eventType: event.event
    });

    // IMMEDIATELY respond to prevent retries
    res.status(200).json({ 
      received: true, 
      message: 'Webhook processed successfully',
      event: event.event 
    });

    // Process webhook asynchronously
    processWebhookEvent(event);

  } catch (error) {
    console.error('❌ Webhook processing error:', error.message);
    console.error('🔍 Error details:', error.stack);
    
    // Still respond with 200 to prevent PayStack retries
    res.status(200).json({ 
      received: true, 
      error: error.message 
    });
  }
});

// Enhanced webhook processing for virtual accounts
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
      case 'transfer.failed':
        await handleFailedTransfer(event.data);
        break;
      case 'charge.failed':
        await handleFailedCharge(event.data);
        break;
      case 'customeridentification.failed':
        await handleCustomerIdentificationFailed(event.data);
        break;
      case 'customeridentification.success':
        await handleCustomerIdentificationSuccess(event.data);
        break;
      default:
        console.log(`ℹ️ Unhandled webhook event: ${event.event}`);
    }
  } catch (error) {
    console.error('❌ Error processing webhook event:', error);
  }
}

// ENHANCED: Handle successful transfers to virtual accounts
async function handleSuccessfulTransfer(transferData) {
  try {
    console.log('💳 Processing successful transfer to virtual account:', transferData.reference);
    
    // Convert amount to Naira
    const amountInNaira = transferData.amount / 100;
    
    // Find user by virtual account number
    const accountNumber = transferData.recipient?.account_number;
    if (!accountNumber) {
      console.log('❌ No account number found in transfer data');
      return;
    }

    console.log('🔍 Looking for user with virtual account:', accountNumber);
    
    // Find user by virtual account number
    const user = await User.findOne({ 
      virtualAccountNumber: accountNumber 
    });

    if (!user) {
      console.log('❌ No user found with virtual account:', accountNumber);
      await storeFailedVirtualAccountTransfer(transferData, 'User not found for virtual account');
      return;
    }

    console.log('✅ Found user for virtual account:', user._id, user.email);

    // Check if transaction already exists
    let transaction = await Transaction.findOne({ reference: transferData.reference });
    
    if (transaction) {
      if (transaction.status !== 'success') {
        transaction.status = 'success';
        transaction.amount = amountInNaira;
        transaction.gatewayResponse = transferData;
        await transaction.save();
        console.log('✅ Updated existing virtual account transaction:', transferData.reference);
      } else {
        console.log('ℹ️ Virtual account transaction already processed:', transferData.reference);
        return;
      }
    } else {
      // Create new virtual account transaction
      transaction = await Transaction.create({
        userId: user._id,
        type: 'wallet_funding',
        amount: amountInNaira,
        reference: transferData.reference,
        status: 'success',
        gateway: 'paystack_virtual_account',
        gatewayResponse: transferData,
        description: `Virtual account deposit - ${accountNumber}`,
        metadata: {
          paystackData: transferData,
          source: 'virtual_account_transfer',
          verifiedAt: new Date(),
          virtualAccountNumber: accountNumber,
          bankName: transferData.recipient?.bank?.name,
          sender: transferData.sender || 'Unknown'
        }
      });
      console.log('✅ New virtual account transaction recorded:', transferData.reference);
    }

    // Update user balance immediately
    await updateUserBalance(user._id, amountInNaira, transferData.reference);

    // Sync with main backend (non-blocking)
    syncVirtualAccountTransferWithMainBackend(user._id, amountInNaira, transferData.reference)
      .catch(error => {
        console.error('⚠️ Virtual account sync failed:', error.message);
      });

    console.log('🎉 Virtual account transfer completed for user:', user.email);

  } catch (error) {
    console.error('❌ Error processing virtual account transfer:', error.message);
    await storeFailedVirtualAccountTransfer(transferData, error.message);
  }
}

// Update user balance immediately
async function updateUserBalance(userId, amount, reference) {
  try {
    console.log(`💰 Updating balance for user ${userId}: +₦${amount}`);
    
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const previousBalance = user.walletBalance;
    user.walletBalance += amount;
    await user.save();

    console.log(`✅ Balance updated: ₦${previousBalance} → ₦${user.walletBalance}`);

    // Store balance update in transaction metadata
    await Transaction.findOneAndUpdate(
      { reference: reference },
      { 
        $set: { 
          'metadata.balanceBefore': previousBalance,
          'metadata.balanceAfter': user.walletBalance,
          'metadata.balanceUpdated': true
        } 
      }
    );

  } catch (error) {
    console.error('❌ Error updating user balance:', error.message);
    throw error;
  }
}

// Sync virtual account transfer with main backend
async function syncVirtualAccountTransferWithMainBackend(userId, amount, reference, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Syncing virtual account transfer with main backend (Attempt ${attempt}/${maxRetries})`);
      
      const syncPayload = {
        userId: userId,
        amount: amount,
        reference: reference,
        description: `Virtual account deposit - Ref: ${reference}`,
        source: 'virtual_account_webhook',
        timestamp: new Date().toISOString(),
        type: 'virtual_account_funding'
      };

      const response = await axios.post(
        `${MAIN_BACKEND_URL}/api/wallet/virtual-account-topup`,
        syncPayload,
        {
          timeout: 15000,
          headers: { 'Content-Type': 'application/json' }
        }
      );

      console.log('✅ Virtual account sync successful:', response.data);
      return response.data;

    } catch (error) {
      console.error(`❌ Virtual account sync attempt ${attempt} failed:`, error.message);
      
      if (attempt === maxRetries) {
        console.error('🚨 All virtual account sync attempts failed');
        // Don't throw - balance is already updated locally
        return;
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, attempt * 2000));
    }
  }
}

// Enhanced charge success handler with instant balance update
async function handleSuccessfulCharge(chargeData) {
  try {
    console.log('💰 Processing successful charge:', chargeData.reference);

    const amountInNaira = chargeData.amount / 100;
    const userId = extractUserIdFromChargeData(chargeData);

    console.log('👤 User ID:', userId, 'Amount:', amountInNaira);

    if (!userId) {
      console.log('❌ No userId found');
      await storeFailedTransaction(chargeData, 'No user ID found');
      return;
    }

    // Verify with PayStack API
    const verificationResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${chargeData.reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
        timeout: 10000,
      }
    ).catch(error => {
      throw new Error(`PayStack verification failed: ${error.message}`);
    });

    const verifiedData = verificationResponse.data.data;

    if (verifiedData.status !== 'success') {
      console.log('❌ Transaction not successful:', verifiedData.status);
      await handleFailedCharge(verifiedData);
      return;
    }

    // Check if transaction exists
    let transaction = await Transaction.findOne({ reference: chargeData.reference });
    
    if (transaction) {
      if (transaction.status !== 'success') {
        transaction.status = 'success';
        transaction.amount = amountInNaira;
        transaction.gatewayResponse = chargeData;
        await transaction.save();
        console.log('✅ Updated existing transaction:', chargeData.reference);
      } else {
        console.log('ℹ️ Transaction already processed');
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
          verifiedAt: new Date(),
          customerEmail: chargeData.customer?.email
        }
      });
      console.log('✅ New transaction recorded:', chargeData.reference);
    }

    // INSTANT BALANCE UPDATE - Even if sync fails
    await updateUserBalance(userId, amountInNaira, chargeData.reference);

    // Sync with main backend (non-blocking)
    syncWithMainBackendWithRetry(userId, amountInNaira, chargeData.reference)
      .catch(error => {
        console.error('❌ Background sync failed, but balance updated locally:', error.message);
      });

    console.log('🎉 Payment processing completed');

  } catch (error) {
    console.error('❌ Error processing charge:', error.message);
    await storeFailedTransaction(chargeData, error.message);
  }
}

// Store failed virtual account transfers
async function storeFailedVirtualAccountTransfer(transferData, error) {
  try {
    await Transaction.create({
      userId: 'unknown',
      type: 'wallet_funding',
      amount: transferData.amount / 100,
      reference: transferData.reference,
      status: 'failed',
      gateway: 'paystack_virtual_account',
      gatewayResponse: transferData,
      description: 'Failed virtual account transfer',
      metadata: {
        paystackData: transferData,
        source: 'virtual_account_webhook_failed',
        failedAt: new Date(),
        error: error.toString(),
        virtualAccountNumber: transferData.recipient?.account_number
      }
    });
    
    console.log('💾 Stored failed virtual account transfer:', transferData.reference);
  } catch (storageError) {
    console.error('❌ Failed to store virtual account transfer:', storageError.message);
  }
}

// Enhanced sync with main backend (for regular payments)
async function syncWithMainBackendWithRetry(userId, amount, reference, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Syncing with main backend (Attempt ${attempt}/${maxRetries})`);
      
      const syncPayload = {
        userId: userId,
        amount: amount,
        reference: reference,
        description: `Wallet funding - Ref: ${reference}`,
        source: 'paystack_webhook',
        timestamp: new Date().toISOString()
      };

      const response = await axios.post(
        `${MAIN_BACKEND_URL}/api/wallet/top-up`,
        syncPayload,
        {
          timeout: 15000,
          headers: { 'Content-Type': 'application/json' }
        }
      );

      console.log('✅ Main backend sync successful');
      return response.data;

    } catch (error) {
      console.error(`❌ Sync attempt ${attempt} failed:`, error.message);
      
      if (attempt === maxRetries) {
        console.error('🚨 All sync attempts failed, but balance updated locally');
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, attempt * 2000));
    }
  }
}

// Handle other webhook events
async function handleFailedCharge(chargeData) {
  console.log('❌ Charge failed:', chargeData.reference);
  // Your existing implementation
}

async function handleFailedTransfer(transferData) {
  console.log('❌ Transfer failed:', transferData.reference);
  // Your existing implementation
}

async function handleCustomerIdentificationFailed(data) {
  console.log('❌ Customer identification failed:', data);
}

async function handleCustomerIdentificationSuccess(data) {
  console.log('✅ Customer identification success:', data);
}

// Utility functions
function validateWebhookEvent(event) {
  return event && event.event && event.data;
}

function extractUserIdFromChargeData(chargeData) {
  // Extract from metadata
  if (chargeData.metadata && chargeData.metadata.userId) {
    return chargeData.metadata.userId;
  }
  
  // Extract from custom fields
  if (chargeData.metadata && chargeData.metadata.custom_fields) {
    const userField = chargeData.metadata.custom_fields.find(
      field => field.variable_name === 'user_id'
    );
    if (userField) return userField.value;
  }
  
  return null;
}

// Export the router
module.exports = router;
