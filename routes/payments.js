const express = require('express');
const router = express.Router();
const axios = require('axios');
const Transaction = require('../models/Transaction');
const VirtualAccount = require('../models/VirtualAccount');

// ✅ SECURE: Use environment variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// Validate that keys are loaded
if (!PAYSTACK_SECRET_KEY) {
    console.error('❌ PAYSTACK_SECRET_KEY is not defined in environment variables');
}

// ✅ PayStack payment verification endpoint
router.post('/verify', async (req, res) => {
    try {
        const { reference, userId } = req.body;

        console.log(`🔍 Verifying PayStack payment: ${reference} for user: ${userId}`);

        if (!reference) {
            return res.status(400).json({
                success: false,
                message: 'Payment reference is required'
            });
        }

        // Verify with PayStack API
        const verifyResponse = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: {
                    'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        const paystackData = verifyResponse.data;

        console.log('📦 PayStack verification response:', {
            status: paystackData.status,
            reference: paystackData.data?.reference,
            amount: paystackData.data?.amount,
            gateway_response: paystackData.data?.gateway_response
        });

        if (paystackData.status === true && paystackData.data.status === 'success') {
            const amount = paystackData.data.amount / 100; // Convert from kobo to naira

            // Check if transaction already exists
            const existingTransaction = await Transaction.findOne({
                reference: reference,
                status: 'success'
            });

            if (existingTransaction) {
                console.log('⚠️ Transaction already processed:', reference);
                return res.json({
                    success: true,
                    message: 'Payment already verified',
                    amount: amount,
                    transactionId: existingTransaction._id,
                    reference: reference
                });
            }

            // Create new transaction record
            const transaction = new Transaction({
                userId: userId,
                type: 'wallet_funding',
                amount: amount,
                reference: reference,
                status: 'success',
                gateway: 'paystack',
                gatewayResponse: paystackData.data,
                description: 'Wallet funding via PayStack'
            });

            await transaction.save();

            console.log('✅ Payment verified and transaction recorded:', {
                userId: userId,
                amount: amount,
                reference: reference
            });

            // Note: Wallet balance update happens in the main backend (vtpass-backend)
            // This service only records the transaction

            res.json({
                success: true,
                message: 'Payment verified successfully',
                amount: amount,
                transactionId: transaction._id,
                reference: reference,
                paystackData: paystackData.data
            });

        } else {
            console.log('❌ PayStack verification failed:', paystackData.data?.gateway_response);
            
            res.status(400).json({
                success: false,
                message: paystackData.data?.gateway_response || 'Payment verification failed',
                gatewayResponse: paystackData.data
            });
        }

    } catch (error) {
        console.error('💥 PayStack verification error:', error.response?.data || error.message);

        // Handle specific PayStack errors
        if (error.response?.status === 404) {
            return res.status(404).json({
                success: false,
                message: 'Transaction not found. Please check the reference code.'
            });
        }

        if (error.response?.status === 401) {
            return res.status(500).json({
                success: false,
                message: 'Payment gateway configuration error'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Payment verification service temporarily unavailable'
        });
    }
});

// ✅ Sync successful payment with main backend
router.post('/sync-success', async (req, res) => {
    try {
        const { userId, reference, amount, paystackData } = req.body;

        console.log('🔄 Syncing successful payment:', { userId, reference, amount });

        // Check if transaction already exists
        const existingTransaction = await Transaction.findOne({
            reference: reference,
            userId: userId
        });

        if (existingTransaction) {
            if (existingTransaction.status === 'success') {
                console.log('ℹ️ Transaction already synced');
                
                return res.json({
                    success: true,
                    message: 'Payment already synced',
                    amount: amount,
                    transactionId: existingTransaction._id
                });
            } else {
                // Update existing failed transaction to success
                existingTransaction.status = 'success';
                existingTransaction.gatewayResponse = paystackData;
                await existingTransaction.save();

                console.log('✅ Updated existing transaction to success');
                
                res.json({
                    success: true,
                    message: 'Transaction updated to success',
                    amount: amount,
                    transactionId: existingTransaction._id
                });
            }
        } else {
            // Create new transaction
            const transaction = new Transaction({
                userId: userId,
                type: 'wallet_funding',
                amount: amount,
                reference: reference,
                status: 'success',
                gateway: 'paystack',
                gatewayResponse: paystackData,
                description: 'Wallet funding via PayStack'
            });

            await transaction.save();
            
            console.log('✅ New transaction synced successfully');
            
            res.json({
                success: true,
                message: 'Payment synced successfully',
                amount: amount,
                transactionId: transaction._id
            });
        }

    } catch (error) {
        console.error('💥 Sync error:', error);
        res.status(500).json({
            success: false,
            message: 'Sync failed: ' + error.message
        });
    }
});

// ✅ Initialize PayStack payment
router.post('/initialize', async (req, res) => {
    try {
        const { userId, email, amount, reference } = req.body;

        console.log('💰 Initializing PayStack payment:', { userId, email, amount, reference });

        if (!email || !amount || !reference) {
            return res.status(400).json({
                success: false,
                message: 'Email, amount, and reference are required'
            });
        }

        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: email,
                amount: amount * 100, // Convert to kobo
                reference: reference,
                currency: 'NGN',
                callback_url: 'https://your-app.com/payment/verify',
                metadata: {
                    userId: userId,
                    custom_fields: [
                        {
                            display_name: "User ID",
                            variable_name: "user_id",
                            value: userId
                        }
                    ]
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        if (paystackResponse.data.status === true) {
            console.log('✅ PayStack payment initialized successfully');
            
            res.json({
                success: true,
                authorizationUrl: paystackResponse.data.data.authorization_url,
                reference: paystackResponse.data.data.reference,
                accessCode: paystackResponse.data.data.access_code,
                message: 'Payment initialized successfully'
            });
        } else {
            throw new Error(paystackResponse.data.message || 'PayStack initialization failed');
        }

    } catch (error) {
        console.error('💥 PayStack initialization error:', error.response?.data || error.message);
        
        res.status(500).json({
            success: false,
            message: 'Payment initialization failed: ' + (error.response?.data?.message || error.message)
        });
    }
});

// ✅ Get transaction history for user
router.get('/transactions/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { page = 1, limit = 20 } = req.query;

        console.log(`📊 Getting transactions for user: ${userId}`);

        const transactions = await Transaction.find({ userId })
            .sort({ createdAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit);

        const total = await Transaction.countDocuments({ userId });

        res.json({
            success: true,
            transactions,
            totalPages: Math.ceil(total / limit),
            currentPage: page,
            total
        });

    } catch (error) {
        console.error('💥 Get transactions error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get transactions'
        });
    }
});

// ✅ Get specific transaction by reference
router.get('/transaction/:reference', async (req, res) => {
    try {
        const { reference } = req.params;

        console.log(`🔍 Getting transaction: ${reference}`);

        const transaction = await Transaction.findOne({ reference });

        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: 'Transaction not found'
            });
        }

        res.json({
            success: true,
            transaction
        });

    } catch (error) {
        console.error('💥 Get transaction error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get transaction'
        });
    }
});

module.exports = router;
