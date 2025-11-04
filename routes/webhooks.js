const express = require('express');
const router = express.Router();
const VirtualAccount = require('../models/VirtualAccount');
const Transaction = require('../models/Transaction');
const axios = require('axios');

// ✅ SECURE: Use environment variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'https://vtpass-backend.onrender.com';

// ✅ PayStack webhook handler for virtual account transactions
router.post('/paystack', async (req, res) => {
    try {
        console.log('📩 PayStack webhook received:', req.body.event);

        // Verify webhook signature (important for security)
        const crypto = require('crypto');
        const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');
        
        if (hash !== req.headers['x-paystack-signature']) {
            console.error('❌ Invalid webhook signature');
            return res.status(401).json({ success: false, message: 'Invalid signature' });
        }

        const event = req.body;
        
        // Handle different webhook events
        switch (event.event) {
            case 'charge.success':
                await handleSuccessfulCharge(event.data);
                break;
                
            case 'transfer.success':
                await handleSuccessfulTransfer(event.data);
                break;
                
            default:
                console.log(`ℹ️ Unhandled webhook event: ${event.event}`);
        }

        console.log('✅ Webhook processed successfully');
        res.json({ success: true, message: 'Webhook processed' });
        
    } catch (error) {
        console.error('❌ Webhook processing error:', error);
        res.status(500).json({ success: false, message: 'Webhook processing failed' });
    }
});

// ✅ ENHANCED: Handle successful charges and update main backend wallet
async function handleSuccessfulCharge(chargeData) {
    try {
        console.log('💰 Processing successful charge:', chargeData.reference);
        
        const amountInNaira = chargeData.amount / 100;
        const userId = chargeData.metadata?.userId || chargeData.customer?.metadata?.userId;
        
        console.log('💳 Charge details:', {
            reference: chargeData.reference,
            amount: amountInNaira,
            userId: userId,
            customerEmail: chargeData.customer?.email
        });

        // Check if transaction already exists
        const existingTransaction = await Transaction.findOne({ 
            reference: chargeData.reference 
        });
        
        if (existingTransaction) {
            console.log('ℹ️ Transaction already processed:', chargeData.reference);
            return;
        }

        // Create transaction record
        const transaction = new Transaction({
            userId: userId || 'unknown',
            type: 'wallet_funding',
            amount: amountInNaira,
            reference: chargeData.reference,
            status: 'success',
            gateway: 'paystack',
            gatewayResponse: chargeData,
            description: `Wallet funding via PayStack`
        });

        await transaction.save();
        console.log('✅ Transaction recorded:', chargeData.reference);

        // ✅ CRITICAL: Update wallet balance in main backend
        if (userId && userId !== 'unknown') {
            await updateMainBackendWallet(userId, amountInNaira, chargeData.reference);
        } else {
            console.log('⚠️ No user ID found in charge data, cannot update main backend');
        }

    } catch (error) {
        console.error('❌ Error processing charge:', error);
    }
}

// ✅ UPDATE MAIN BACKEND WALLET BALANCE
async function updateMainBackendWallet(userId, amount, reference) {
    try {
        console.log(`🔄 Updating main backend wallet for user ${userId}: ₦${amount}`);
        
        const updateData = {
            userId: userId,
            amount: amount,
            reference: reference,
            type: 'credit',
            description: `Wallet funding via PayStack - Ref: ${reference}`,
            source: 'paystack_funding'
        };

        // Call main backend to update wallet balance
        const response = await axios.post(
            `${MAIN_BACKEND_URL}/api/wallet/top-up`,
            updateData,
            {
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: 10000
            }
        );

        if (response.data.success) {
            console.log('✅ Main backend wallet updated successfully');
        } else {
            console.error('❌ Main backend wallet update failed:', response.data.message);
        }

    } catch (error) {
        console.error('💥 Failed to update main backend wallet:', error.message);
    }
}

// Handle successful transfers
async function handleSuccessfulTransfer(transferData) {
    try {
        console.log('💸 Transfer successful:', transferData.reference);
        // Handle transfer success logic here
    } catch (error) {
        console.error('❌ Error processing transfer:', error);
    }
}

// Test webhook endpoint
router.get('/test', (req, res) => {
    res.json({
        success: true,
        message: 'Webhook endpoint is working',
        webhook_url: 'https://virtual-account-backend.onrender.com/api/webhooks/paystack'
    });
});

module.exports = router;
