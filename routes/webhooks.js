const express = require('express');
const router = express.Router();
const VirtualAccount = require('../models/VirtualAccount');
const Transaction = require('../models/Transaction');
const axios = require('axios');

// ✅ SECURE: Use environment variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'https://vtpass-backend.onrender.com';

// Validate webhook secret key
if (!PAYSTACK_SECRET_KEY) {
    console.error('❌ PAYSTACK_SECRET_KEY is not defined in environment variables');
}

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
                
            case 'dedicatedaccount.assign':
                await handleVirtualAccountAssignment(event.data);
                break;
                
            case 'dedicatedaccount.create':
                await handleVirtualAccountCreation(event.data);
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
            description: `Wallet funding via PayStack - ${chargeData.authorization?.channel || 'virtual_account'}`
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

// ✅ NEW: Update main backend wallet balance
async function updateMainBackendWallet(userId, amount, reference) {
    try {
        console.log(`🔄 Updating main backend wallet for user ${userId}: ₦${amount}`);
        
        const updateData = {
            userId: userId,
            amount: amount,
            reference: reference,
            type: 'credit',
            description: `Wallet funding via PayStack - Ref: ${reference}`
        };

        // Call main backend to update wallet balance
        const response = await axios.post(
            `${MAIN_BACKEND_URL}/api/wallet/top-up`,
            updateData,
            {
                headers: {
                    'Content-Type': 'application/json',
                    // Add any required authentication headers here
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
        console.error('💥 Failed to update main backend wallet:', {
            message: error.message,
            response: error.response?.data,
            status: error.response?.status
        });
        
        // You might want to implement retry logic here
    }
}

// Handle virtual account assignment
async function handleVirtualAccountAssignment(accountData) {
    try {
        console.log('🔗 Virtual account assigned:', accountData.account_number);
        
        // Update virtual account status in database
        await VirtualAccount.findOneAndUpdate(
            { accountNumber: accountData.account_number },
            { 
                assigned: true,
                active: true,
                customerCode: accountData.customer.customer_code
            },
            { new: true }
        );
        
        console.log(`✅ Virtual account ${accountData.account_number} assignment recorded`);
    } catch (error) {
        console.error('❌ Error processing account assignment:', error);
    }
}

// Handle virtual account creation
async function handleVirtualAccountCreation(accountData) {
    try {
        console.log('🆕 Virtual account created:', accountData.account_number);
        
        const existingAccount = await VirtualAccount.findOne({ 
            accountNumber: accountData.account_number 
        });
        
        if (!existingAccount) {
            console.log('ℹ️ New virtual account created via webhook');
            // You could create a record here if needed
        }
        
    } catch (error) {
        console.error('❌ Error processing account creation:', error);
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
        webhook_url: 'https://virtual-account-backend.onrender.com/api/webhooks/paystack',
        main_backend_url: MAIN_BACKEND_URL
    });
});

module.exports = router;
