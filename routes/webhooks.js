// routes/webhooks.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL;
const MAIN_BACKEND_TOKEN = process.env.MAIN_BACKEND_TOKEN;

// --- Raw body parser for Paystack ---
router.use((req, res, next) => {
  if (req.originalUrl.includes('/paystack')) {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      req.rawBody = data;
      try {
        req.body = JSON.parse(data);
      } catch (err) {
        req.body = {};
      }
      next();
    });
  } else next();
});

// --- Paystack webhook endpoint ---
router.post('/paystack', async (req, res) => {
  try {
    // Step 1: Validate signature
    const signature = req.headers['x-paystack-signature'];
    if (!signature) return res.status(401).send('No signature provided');

    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY)
                       .update(req.rawBody)
                       .digest('hex');

    if (hash !== signature) return res.status(401).send('Invalid signature');

    // Step 2: Acknowledge immediately to Paystack
    res.status(200).send('Received');

    // Step 3: Process event asynchronously
    const event = req.body;
    if (!event || !event.event || !event.data) return;

    switch (event.event) {
      case 'charge.success':
        await handleChargeSuccess(event.data);
        break;
      case 'transfer.success':
        await handleVirtualAccountTransfer(event.data);
        break;
      case 'charge.failed':
        await handleFailedCharge(event.data);
        break;
      case 'transfer.failed':
        await handleFailedTransfer(event.data);
        break;
      case 'customeridentification.success':
        console.log('✅ Customer identification success:', event.data);
        break;
      case 'customeridentification.failed':
        console.log('❌ Customer identification failed:', event.data);
        break;
      default:
        console.log('ℹ️ Unhandled event:', event.event);
    }

  } catch (err) {
    console.error('❌ Webhook processing error:', err.message);
  }
});

// --- Handle successful wallet charge ---
async function handleChargeSuccess(data) {
  try {
    const userId = extractUserIdFromMetadata(data);
    if (!userId) return console.log('❌ No userId found in metadata');

    const amount = data.amount / 100; // convert kobo to Naira
    const user = await User.findById(userId);
    if (!user) return console.log('❌ User not found:', userId);

    // Check for existing transaction
    let txn = await Transaction.findOne({ reference: data.reference });
    if (txn && txn.status === 'success') return;
    if (!txn) {
      txn = await Transaction.create({
        userId,
        type: 'wallet_funding',
        amount,
        reference: data.reference,
        status: 'success',
        gateway: 'paystack',
        gatewayResponse: data,
        description: 'Wallet top-up via Paystack',
        metadata: { paystackData: data, verifiedAt: new Date() }
      });
    } else {
      txn.status = 'success';
      txn.amount = amount;
      txn.gatewayResponse = data;
      await txn.save();
    }

    // Update user balance
    const prevBalance = user.walletBalance;
    user.walletBalance += amount;
    await user.save();

    // Update transaction metadata with balance info
    await Transaction.findByIdAndUpdate(txn._id, {
      $set: {
        'metadata.balanceBefore': prevBalance,
        'metadata.balanceAfter': user.walletBalance
      }
    });

    // Sync with main backend (non-blocking)
    syncWithMainBackend(user._id, amount, data.reference, 'wallet_funding');

    console.log(`✅ Wallet funding successful for user ${user.email}: +₦${amount}`);

  } catch (err) {
    console.error('❌ Error in handleChargeSuccess:', err.message);
  }
}

// --- Handle virtual account deposit ---
async function handleVirtualAccountTransfer(data) {
  try {
    const accountNumber = data.recipient?.account_number;
    if (!accountNumber) return console.log('❌ No virtual account number found');

    const user = await User.findOne({ 'virtualAccount.accountNumber': accountNumber });
    if (!user) return console.log('❌ No user found for virtual account', accountNumber);

    const amount = data.amount / 100; // kobo → Naira

    // Check for existing transaction
    let txn = await Transaction.findOne({ reference: data.reference });
    if (txn && txn.status === 'success') return;
    if (!txn) {
      txn = await Transaction.create({
        userId: user._id,
        type: 'wallet_funding',
        amount,
        reference: data.reference,
        status: 'success',
        gateway: 'paystack_virtual_account',
        gatewayResponse: data,
        description: `Virtual account deposit - ${accountNumber}`,
        metadata: {
          paystackData: data,
          source: 'virtual_account_transfer',
          virtualAccountNumber: accountNumber,
          verifiedAt: new Date()
        }
      });
    } else {
      txn.status = 'success';
      txn.amount = amount;
      txn.gatewayResponse = data;
      await txn.save();
    }

    // Update user balance
    const prevBalance = user.walletBalance;
    user.walletBalance += amount;
    await user.save();

    // Update transaction metadata
    await Transaction.findByIdAndUpdate(txn._id, {
      $set: {
        'metadata.balanceBefore': prevBalance,
        'metadata.balanceAfter': user.walletBalance
      }
    });

    // Sync with main backend (non-blocking)
    syncWithMainBackend(user._id, amount, data.reference, 'virtual_account');

    console.log(`✅ Virtual account deposit successful for ${user.email}: +₦${amount}`);

  } catch (err) {
    console.error('❌ Error in handleVirtualAccountTransfer:', err.message);
  }
}

// --- Failed charge handler ---
async function handleFailedCharge(data) {
  console.log('❌ Charge failed:', data.reference);
  await storeFailedTransaction(data, 'charge_failed');
}

// --- Failed transfer handler ---
async function handleFailedTransfer(data) {
  console.log('❌ Transfer failed:', data.reference);
  await storeFailedTransaction(data, 'transfer_failed');
}

// --- Store failed transaction for logging ---
async function storeFailedTransaction(data, type) {
  try {
    await Transaction.create({
      userId: 'unknown',
      type: 'wallet_funding',
      amount: data.amount ? data.amount / 100 : 0,
      reference: data.reference || 'unknown',
      status: 'failed',
      gateway: type.includes('transfer') ? 'paystack_virtual_account' : 'paystack',
      gatewayResponse: data,
      description: 'Failed transaction',
      metadata: { rawData: data, errorType: type, createdAt: new Date() }
    });
    console.log('💾 Failed transaction stored:', data.reference);
  } catch (err) {
    console.error('❌ Failed to store failed transaction:', err.message);
  }
}

// --- Sync with main backend ---
async function syncWithMainBackend(userId, amount, reference, type) {
  try {
    const payload = {
      userId,
      amount,
      transactionId: reference,
      type,
      timestamp: new Date().toISOString()
    };
    await axios.post(`${MAIN_BACKEND_URL}/api/fund-wallet`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MAIN_BACKEND_TOKEN}`
      },
      timeout: 15000
    });
    console.log(`🔄 Synced ${type} to main backend: ${reference}`);
  } catch (err) {
    console.error('❌ Backend sync failed:', err.message);
  }
}

// --- Utility to extract userId from Paystack metadata ---
function extractUserIdFromMetadata(data) {
  if (!data || !data.metadata) return null;
  return data.metadata.userId || null;
}

module.exports = router;
