const express = require('express');
const router = express.Router();
const VirtualAccount = require('../models/VirtualAccount');
const axios = require('axios');

// PayStack webhook secret (set this in your PayStack dashboard)
const PAYSTACK_SECRET_KEY = 'sk_test_bda38e781c1781083e6ca116c48cc52609205da3';

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

// Handle successful charges (payments to virtual accounts)
async function handleSuccessfulCharge(chargeData) {
    try {
        console.log('💰 Processing successful charge:', chargeData.reference);
        
        // Find virtual account by account number
        const virtualAccount = await VirtualAccount.findOne({ 
            accountNumber: chargeData.authorization.channel 
        });
        
        if (virtualAccount) {
            console.log(`✅ Charge of ${chargeData.amount} for account ${virtualAccount.accountNumber}`);
            
            // Update account balance or trigger other actions
            // You might want to create a transaction record here
            
        } else {
            console.log('❌ Virtual account not found for charge');
        }
    } catch (error) {
        console.error('❌ Error processing charge:', error);
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
        
        // This might be redundant since we create via API, but good to have
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
        webhook_url: 'https://virtual-account-backend.onrender.com/api/webhooks/paystack'
    });
});

module.exports = router;
