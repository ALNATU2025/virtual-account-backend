// routes/webhook.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const User = require('../models/User');
const VirtualAccount = require('../models/VirtualAccount');
const Transaction = require('../models/Transaction');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL;

// Middleware to parse raw body for Paystack webhook
router.use('/paystack', (req, res, next) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
        req.rawBody = data;
        try {
            req.body = JSON.parse(data);
        } catch (err) {
            console.error('❌ Webhook JSON parse error:', err.message);
            return res.status(400).send('Invalid JSON');
        }
        next();
    });
});

// Paystack webhook endpoint
router.post('/paystack', async (req, res) => {
    console.log('📨 Paystack webhook received');

    const signature = req.headers['x-paystack-signature'];
    if (!signature) {
        console.log('❌ No signature header found');
        return res.status(401).json({ success: false, message: 'No signature' });
    }

    // Verify signature
    const hash = crypto
        .createHmac('sha512', PAYSTACK_SECRET_KEY)
        .update(req.rawBody)
        .digest('hex');

    if (hash !== signature) {
        console.log('❌ Invalid signature');
        return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    console.log('🔐 Signature verified');

    // Respond immediately to prevent Paystack retries
    res.status(200).json({ received: true });

    const event = req.body;

    try {
        console.log('📝 Event type:', event.event);
        if (!event.data) return console.log('❌ No data in event');

        switch (event.event) {
            case 'transfer.success':
                await handleVirtualAccountTransfer(event.data);
                break;

            case 'charge.success':
                await handleCharge(event.data);
                break;

            default:
                console.log('ℹ️ Unhandled event type:', event.event);
        }
    } catch (err) {
        console.error('❌ Error processing webhook event:', err);
    }
});

// Handle virtual account transfer
async function handleVirtualAccountTransfer(data) {
    console.log('💳 Handling virtual account transfer:', data.reference);

    const accountNumber = data.recipient?.account_number;
    if (!accountNumber) return console.log('❌ No account number in transfer data');

    const userVA = await VirtualAccount.findOne({ accountNumber });
    if (!userVA) {
        console.log('❌ No user found with this virtual account:', accountNumber);
        return storeFailedVirtualAccount(data, 'User not found for VA');
    }

    const user = await User.findById(userVA.userId);
    if (!user) {
        console.log('❌ User not found for VA:', accountNumber);
        return storeFailedVirtualAccount(data, 'User document not found');
    }

    const amount = data.amount / 100; // Convert kobo to Naira
    console.log(`👤 User: ${user.email}, Amount: ₦${amount}`);

    // Check if transaction already exists
    let txn = await Transaction.findOne({ reference: data.reference });
    if (txn) {
        console.log('ℹ️ Transaction already exists:', data.reference);
        return;
    }

    // Update user wallet
    const previousBalance = user.walletBalance;
    user.walletBalance += amount;
    await user.save();

    console.log(`💰 Wallet updated: ₦${previousBalance} → ₦${user.walletBalance}`);

    // Record transaction
    await Transaction.create({
        userId: user._id,
        type: 'wallet_funding',
        amount,
        reference: data.reference,
        status: 'success',
        gateway: 'paystack_virtual_account',
        gatewayResponse: data,
        description: `Virtual account deposit - ${accountNumber}`,
        metadata: {
            balanceBefore: previousBalance,
            balanceAfter: user.walletBalance,
            virtualAccountNumber: accountNumber,
            verifiedAt: new Date()
        }
    });

    console.log('✅ Transaction recorded:', data.reference);

    // Optional: sync with main backend
    try {
        await axios.post(
            `${MAIN_BACKEND_URL}/api/fund-wallet`,
            {
                userId: user._id,
                amount,
                transactionId: data.reference,
                details: { source: 'virtual_account_transfer' }
            },
            { headers: { Authorization: `Bearer ${process.env.MAIN_BACKEND_TOKEN}` } }
        );
        console.log('🌐 Synced with main backend');
    } catch (syncErr) {
        console.error('⚠️ Main backend sync failed:', syncErr.message);
    }
}

// Handle normal charge
async function handleCharge(data) {
    console.log('💳 Handling charge:', data.reference);

    const userId = data.metadata?.userId;
    if (!userId) return console.log('❌ No userId in charge metadata');

    const user = await User.findById(userId);
    if (!user) return console.log('❌ User not found for charge:', data.reference);

    const amount = data.amount / 100;
    const previousBalance = user.walletBalance;
    user.walletBalance += amount;
    await user.save();

    console.log(`💰 Wallet updated for charge: ₦${previousBalance} → ₦${user.walletBalance}`);

    await Transaction.create({
        userId: user._id,
        type: 'wallet_funding',
        amount,
        reference: data.reference,
        status: 'success',
        gateway: 'paystack',
        gatewayResponse: data,
        description: 'Wallet funding via Paystack charge',
        metadata: {
            balanceBefore: previousBalance,
            balanceAfter: user.walletBalance,
            verifiedAt: new Date()
        }
    });

    console.log('✅ Charge transaction recorded:', data.reference);
}

// Store failed virtual account transfer
async function storeFailedVirtualAccount(data, reason) {
    console.log('❌ Storing failed VA transaction:', data.reference, 'Reason:', reason);
    await Transaction.create({
        userId: 'unknown',
        type: 'wallet_funding',
        amount: data.amount / 100,
        reference: data.reference,
        status: 'failed',
        gateway: 'paystack_virtual_account',
        gatewayResponse: data,
        description: 'Failed virtual account transfer',
        metadata: { reason, attemptedAt: new Date() }
    });
}

module.exports = router;
