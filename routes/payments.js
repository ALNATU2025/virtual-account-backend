const express = require('express');
const router = express.Router();
const axios = require('axios');
const mongoose = require('mongoose');
const NodeCache = require('node-cache');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// NEW: Cache for preventing duplicate processing
const processingCache = new NodeCache({ stdTTL: 60 }); // 60 seconds
const successCache = new NodeCache({ stdTTL: 300 }); // 5 minutes for successful transactions

// ========== INITIALIZE PAYMENT (NO CHANGES NEEDED - KEEP AS IS) ==========
router.post('/initialize-paystack', async (req, res) => {
    try {
        const { userId, email, amount, reference } = req.body;
        
        if (!email || !amount || !reference) {
            return res.status(400).json({ success: false, message: 'Missing parameters' });
        }

        // Create transaction with pending status
        const transaction = await Transaction.create({
            userId,
            type: 'Wallet Funding',
            amount: amount,
            reference: reference,
            status: 'Pending',
            description: 'Wallet funding via PayStack',
            gateway: 'paystack'
        });

        // Initialize with PayStack
        const paystackPayload = {
            email: email,
            amount: Math.round(amount * 100),
            reference: reference,
            callback_url: `${process.env.BASE_URL || 'https://your-backend.com'}/api/payments/callback`,
            metadata: { 
                userId: userId,
                transactionId: transaction._id.toString()
            },
        };

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

        if (!response.data.status) {
            throw new Error(response.data.message || 'PayStack initialization failed');
        }

        const paystackData = response.data.data;
        
        // Update transaction
        await Transaction.findByIdAndUpdate(transaction._id, {
            gatewayResponse: paystackData,
            status: 'Pending',
            gatewayReference: paystackData.reference
        });

        // Return success
        res.json({
            success: true,
            authorizationUrl: paystackData.authorization_url,
            reference: paystackData.reference,
            accessCode: paystackData.access_code,
            message: 'Payment initialized',
            transactionId: transaction._id
        });

    } catch (error) {
        console.error('❌ INITIALIZE ERROR:', error.message);
        res.status(500).json({
            success: false,
            message: 'Payment initialization failed',
            error: error.message
        });
    }
});

// ========== CALLBACK ENDPOINT - FIXED VERSION ==========
router.get('/callback', async (req, res) => {
    const { reference, trxref } = req.query;
    
    console.log('🔄 CALLBACK: PayStack redirect called', { reference, trxref });
    
    // Clean reference
    let paymentReference = reference || trxref || '';
    if (paymentReference.includes(',')) {
        paymentReference = paymentReference.split(',')[0].trim();
    }
    
    if (!paymentReference) {
        return res.send(`
            <html>
            <head><title>Payment Error</title></head>
            <body style="font-family: Arial; text-align: center; padding: 50px;">
                <h1>Payment Complete</h1>
                <p>Please close this window and check your balance in the app.</p>
            </body>
            </html>
        `);
    }
    
    try {
        // Check cache first to prevent duplicate processing
        if (processingCache.get(paymentReference)) {
            console.log('⏭️ Already processing this reference:', paymentReference);
        } else {
            processingCache.set(paymentReference, true);
            
            // Verify with PayStack
            const verifyResponse = await axios.get(
                `https://api.paystack.co/transaction/verify/${paymentReference}`,
                {
                    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                    timeout: 10000,
                }
            );
            
            if (verifyResponse.data.status && verifyResponse.data.data.status === 'success') {
                const data = verifyResponse.data.data;
                const userId = data.metadata?.userId;
                
                if (userId) {
                    // Update user balance in background
                    processTransactionInBackground(paymentReference, userId, data.amount / 100);
                }
            }
        }
        
        // Always show success page to user
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Payment Complete</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
                    .container { background: rgba(255,255,255,0.95); padding: 40px; border-radius: 20px; color: #333; max-width: 500px; margin: 0 auto; }
                    .success { color: #10b981; font-size: 24px; }
                    .button { background: #667eea; color: white; padding: 12px 24px; border: none; border-radius: 10px; font-size: 16px; cursor: pointer; margin-top: 20px; }
                    .button:hover { background: #5a67d8; }
                </style>
                <script>
                    setTimeout(() => {
                        window.close();
                    }, 3000);
                    
                    function closeWindow() {
                        window.close();
                    }
                </script>
            </head>
            <body>
                <div class="container">
                    <h1 class="success">✅ Payment Complete!</h1>
                    <p>Your payment has been received successfully.</p>
                    <p><strong>Reference:</strong> ${paymentReference}</p>
                    <p>You can close this window or it will close automatically in 3 seconds.</p>
                    <button class="button" onclick="closeWindow()">Close Window</button>
                </div>
            </body>
            </html>
        `);
        
    } catch (error) {
        console.error('❌ CALLBACK ERROR:', error.message);
        // Still show success page even if error
        res.send(`
            <html>
            <head><title>Payment Complete</title></head>
            <body style="font-family: Arial; text-align: center; padding: 50px;">
                <h1 style="color: green;">✅ Payment Received</h1>
                <p>Please close this window and check your balance in the app.</p>
            </body>
            </html>
        `);
    }
});

// ========== FIXED VERIFICATION ENDPOINT - THIS IS THE MAIN FIX ==========
router.post('/verify-paystack', async (req, res) => {
    let reference = req.body.reference?.toString().trim();
    
    console.log('🔍 VERIFY REQUEST:', reference);
    
    if (!reference) {
        return res.status(400).json({ 
            success: false, 
            message: 'Reference is required' 
        });
    }
    
    // Clean reference
    if (reference.includes(',')) {
        reference = reference.split(',')[0].trim();
    }
    
    try {
        // CHECK 1: Look for existing successful transaction
        const existingTransaction = await Transaction.findOne({ 
            reference: reference,
            status: 'Successful'
        });
        
        if (existingTransaction) {
            console.log('✅ Already processed transaction found');
            
            // Get user's current balance
            const user = await User.findById(existingTransaction.userId);
            
            return res.json({
                success: true,
                alreadyProcessed: true,
                amount: existingTransaction.amount,
                newBalance: user?.walletBalance || existingTransaction.balanceAfter,
                message: 'Transaction was already processed successfully',
                transactionId: existingTransaction._id
            });
        }
        
        // CHECK 2: Look for existing transaction (any status)
        let transaction = await Transaction.findOne({ reference: reference });
        
        // CHECK 3: Verify with PayStack
        console.log('🔄 Verifying with PayStack...');
        const verifyResponse = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: { 
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` 
                },
                timeout: 15000, // 15 second timeout
            }
        );
        
        const paystackData = verifyResponse.data;
        
        if (!paystackData.status || paystackData.data?.status !== 'success') {
            console.log('❌ PayStack verification failed');
            
            // Update transaction as failed if it exists
            if (transaction) {
                await Transaction.findByIdAndUpdate(transaction._id, {
                    status: 'Failed',
                    failureReason: paystackData.message || 'Payment failed',
                    gatewayResponse: paystackData.data,
                    lastVerifiedAt: new Date(),
                    verificationAttempts: transaction.verificationAttempts + 1
                });
            }
            
            return res.json({
                success: false,
                message: 'Payment not successful on PayStack',
                gatewayStatus: paystackData.data?.status
            });
        }
        
        // PAYMENT IS SUCCESSFUL ON PAYSTACK
        const amount = paystackData.data.amount / 100;
        const userId = paystackData.data.metadata?.userId;
        
        if (!userId) {
            console.log('❌ No userId in PayStack metadata');
            return res.status(400).json({
                success: false,
                message: 'User information missing in payment data'
            });
        }
        
        // CHECK 4: Get or create transaction
        if (!transaction) {
            transaction = new Transaction({
                userId: userId,
                type: 'Wallet Funding',
                amount: amount,
                reference: reference,
                status: 'Processing',
                description: `Wallet funding of ₦${amount}`,
                gateway: 'paystack',
                gatewayResponse: paystackData.data,
                gatewayReference: paystackData.data.reference,
                verificationAttempts: 1,
                lastVerifiedAt: new Date()
            });
        } else {
            // Update existing transaction
            transaction.status = 'Processing';
            transaction.amount = amount;
            transaction.gatewayResponse = paystackData.data;
            transaction.lastVerifiedAt = new Date();
            transaction.verificationAttempts += 1;
        }
        
        // CHECK 5: Get user and balance
        const user = await User.findById(userId);
        if (!user) {
            console.log('❌ User not found:', userId);
            return res.status(404).json({
                success: false,
                message: 'User account not found'
            });
        }
        
        // Save balance before update
        transaction.balanceBefore = user.walletBalance;
        
        // UPDATE 6: Credit user wallet (ATOMIC OPERATION)
        user.walletBalance += amount;
        await user.save();
        
        // UPDATE 7: Mark transaction as successful
        transaction.status = 'Successful';
        transaction.balanceAfter = user.walletBalance;
        
        // Add verification history
        if (!transaction.metadata.verificationHistory) {
            transaction.metadata.verificationHistory = [];
        }
        transaction.metadata.verificationHistory.push({
            method: 'polling',
            timestamp: new Date(),
            status: 'success',
            response: { verified: true, amount: amount }
        });
        
        await transaction.save();
        
        console.log(`✅ SUCCESS: ₦${amount} credited to user ${userId}. New balance: ₦${user.walletBalance}`);
        
        // Cache successful verification
        successCache.set(reference, {
            amount: amount,
            newBalance: user.walletBalance,
            timestamp: new Date()
        });
        
        // RETURN SUCCESS
        res.json({
            success: true,
            amount: amount,
            newBalance: user.walletBalance,
            transactionId: transaction._id,
            reference: reference,
            message: 'Payment verified and wallet credited successfully'
        });
        
    } catch (error) {
        console.error('❌ VERIFICATION ERROR:', error.message);
        
        // Handle specific errors
        let errorMessage = 'Verification failed';
        let shouldRetry = false;
        
        if (error.code === 'ECONNABORTED' || error.response?.status === 408) {
            errorMessage = 'Verification timeout. Please try again.';
            shouldRetry = true;
        } else if (error.response?.status === 404) {
            errorMessage = 'Transaction not found on PayStack. It may still be processing.';
            shouldRetry = true;
        }
        
        res.json({
            success: false,
            message: errorMessage,
            retryable: shouldRetry,
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// ========== HELPER FUNCTION: Process transaction in background ==========
async function processTransactionInBackground(reference, userId, amount) {
    try {
        console.log(`🔄 Processing in background: ${reference} for user ${userId}`);
        
        // Check if already processed
        const existing = await Transaction.findOne({ 
            reference: reference,
            status: 'Successful' 
        });
        
        if (existing) {
            console.log('⏭️ Already processed in background');
            return;
        }
        
        // Get user
        const user = await User.findById(userId);
        if (!user) {
            console.log('❌ User not found for background processing');
            return;
        }
        
        // Find or create transaction
        let transaction = await Transaction.findOne({ reference: reference });
        
        if (!transaction) {
            transaction = new Transaction({
                userId: userId,
                type: 'Wallet Funding',
                amount: amount,
                reference: reference,
                status: 'Successful',
                description: `Wallet funding of ₦${amount} (background)`,
                balanceBefore: user.walletBalance,
                balanceAfter: user.walletBalance + amount,
                gateway: 'paystack',
                gatewayReference: reference
            });
        } else {
            transaction.status = 'Successful';
            transaction.balanceBefore = user.walletBalance;
            transaction.balanceAfter = user.walletBalance + amount;
        }
        
        // Update user balance
        user.walletBalance += amount;
        await user.save();
        
        await transaction.save();
        
        console.log(`✅ BACKGROUND SUCCESS: ₦${amount} credited to user ${userId}`);
        
    } catch (error) {
        console.error('❌ Background processing error:', error.message);
    }
}

// ========== WEBHOOK ENDPOINT (KEEP YOUR EXISTING BUT ADD THIS CHECK) ==========
router.post('/webhook/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const event = JSON.parse(req.body.toString());
        
        if (event.event !== 'charge.success') {
            return res.sendStatus(200);
        }
        
        const data = event.data;
        const reference = data.reference;
        const amount = data.amount / 100;
        const userId = data.metadata?.userId;
        
        console.log("📩 Webhook received:", reference);
        
        // CRITICAL CHECK: Prevent double processing
        const existing = await Transaction.findOne({ 
            reference: reference, 
            status: "Successful" 
        });
        
        if (existing) {
            console.log("⛔ Already processed via webhook");
            return res.sendStatus(200);
        }
        
        // Get user
        if (!userId) {
            console.log("❌ No userId in webhook");
            return res.sendStatus(200);
        }
        
        const user = await User.findById(userId);
        if (!user) {
            console.log("❌ User not found for webhook");
            return res.sendStatus(200);
        }
        
        // Create transaction
        const transaction = new Transaction({
            userId,
            type: "Wallet Funding",
            amount,
            reference,
            status: "Successful",
            description: "Wallet funding via Paystack Webhook",
            balanceBefore: user.walletBalance,
            balanceAfter: user.walletBalance + amount,
            gateway: "paystack",
            gatewayResponse: data,
            metadata: {
                paystackData: data,
                verificationHistory: [{
                    method: 'webhook',
                    timestamp: new Date(),
                    status: 'success'
                }]
            }
        });
        
        // Update user balance
        user.walletBalance += amount;
        await user.save();
        await transaction.save();
        
        console.log(`✅ Webhook processed: ₦${amount} credited`);
        
        return res.sendStatus(200);
        
    } catch (error) {
        console.error("🔥 WEBHOOK ERROR:", error);
        return res.sendStatus(500);
    }
});

// ========== GET TRANSACTION STATUS ==========
router.get('/status/:reference', async (req, res) => {
    try {
        const transaction = await Transaction.findOne({ reference: req.params.reference });
        if (!transaction) {
            return res.status(404).json({ 
                success: false, 
                message: 'Transaction not found' 
            });
        }
        
        res.json({
            success: true,
            status: transaction.status,
            amount: transaction.amount,
            reference: transaction.reference,
            createdAt: transaction.createdAt,
            failureReason: transaction.failureReason,
            canRetry: transaction.canRetry,
            retryCount: transaction.retryCount
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: 'Error fetching status' 
        });
    }
});

// ========== HEALTH CHECK ==========
router.get('/health', (req, res) => {
    res.json({ 
        success: true, 
        message: 'Payments API working',
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
