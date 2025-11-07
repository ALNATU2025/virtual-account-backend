const express = require('express');
const router = express.Router();
const axios = require('axios');
const Transaction = require('../models/Transaction');
const VirtualAccount = require('../models/VirtualAccount');
const path = require('path');

// ✅ SECURE: Use environment variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'https://vtpass-backend.onrender.com';

// Validate that keys are loaded
if (!PAYSTACK_SECRET_KEY) {
    console.error('❌ PAYSTACK_SECRET_KEY is not defined in environment variables');
}


// ✅ ENHANCED GET endpoint for payment verification
router.get('/verify', async (req, res) => {
    try {
        const { reference, trxref, redirect = 'true' } = req.query;
        const paymentReference = reference || trxref;

        console.log(`🔍 GET Verifying PayStack payment: ${paymentReference}`);

        if (!paymentReference) {
            return res.redirect('/api/payments/success');
        }

        // Verify with PayStack API
        const verifyResponse = await axios.get(
            `https://api.paystack.co/transaction/verify/${paymentReference}`,
            {
                headers: {
                    'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        const paystackData = verifyResponse.data;

        console.log('📦 GET PayStack verification response:', {
            status: paystackData.status,
            reference: paystackData.data?.reference,
            amount: paystackData.data?.amount,
            gateway_response: paystackData.data?.gateway_response
        });

        if (paystackData.status === true && paystackData.data.status === 'success') {
            const amount = paystackData.data.amount / 100;
            const userId = paystackData.data.metadata?.userId || paystackData.data.customer?.email;

            // Check if transaction already exists
            const existingTransaction = await Transaction.findOne({
                reference: paymentReference,
                status: 'success'
            });

            let transaction = existingTransaction;

            if (!existingTransaction) {
                // Create new transaction record
                transaction = new Transaction({
                    userId: userId,
                    type: 'wallet_funding',
                    amount: amount,
                    reference: paymentReference,
                    status: 'success',
                    gateway: 'paystack',
                    gatewayResponse: paystackData.data,
                    description: 'Wallet funding via PayStack'
                });

                await transaction.save();
                console.log('✅ New transaction recorded:', paymentReference);
            }

            // Sync with main backend
            const syncResult = await _syncWithMainBackend(userId, amount, paymentReference);

            // If redirect is true, serve the success page
            if (redirect === 'true') {
                return res.redirect(`/api/payments/success?reference=${paymentReference}`);
            }

            // Return JSON response if no redirect
            res.json({
                success: true,
                message: 'Payment verified successfully',
                amount: amount,
                transactionId: transaction._id,
                reference: paymentReference,
                userId: userId,
                newBalance: syncResult.newBalance,
                paystackData: paystackData.data
            });

        } else {
            console.log('❌ GET PayStack verification failed');
            
            // Redirect to success page even if verification fails
            if (redirect === 'true') {
                return res.redirect(`/api/payments/success?reference=${paymentReference}`);
            }
            
            res.status(400).json({
                success: false,
                message: paystackData.data?.gateway_response || 'Payment verification failed'
            });
        }

    } catch (error) {
        console.error('💥 GET PayStack verification error:', error.response?.data || error.message);

        // Even on error, redirect to success page
        const { reference, trxref } = req.query;
        const paymentReference = reference || trxref;
        
        if (req.query.redirect === 'true' && paymentReference) {
            return res.redirect(`/api/payments/success?reference=${paymentReference}`);
        }

        res.status(500).json({
            success: false,
            message: 'Payment verification service temporarily unavailable'
        });
    }
});

// ✅ PayStack payment verification endpoint (POST - existing)
router.post('/verify', async (req, res) => {
    try {
        const { reference, userId } = req.body;

        console.log(`🔍 POST Verifying PayStack payment: ${reference} for user: ${userId}`);

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

        console.log('📦 POST PayStack verification response:', {
            status: paystackData.status,
            reference: paystackData.data?.reference,
            amount: paystackData.data?.amount,
            gateway_response: paystackData.data?.gateway_response
        });

        if (paystackData.status === true && paystackData.data.status === 'success') {
            const amount = paystackData.data.amount / 100;

            // Check if transaction already exists
            const existingTransaction = await Transaction.findOne({
                reference: reference,
                status: 'success'
            });

            let transaction = existingTransaction;

            if (!existingTransaction) {
                // Create new transaction record
                transaction = new Transaction({
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
                console.log('✅ POST Payment verified and transaction recorded:', {
                    userId: userId,
                    amount: amount,
                    reference: reference
                });
            }

            // Sync with main backend
            const syncResult = await _syncWithMainBackend(userId, amount, reference);

            res.json({
                success: true,
                message: 'Payment verified successfully',
                amount: amount,
                transactionId: transaction._id,
                reference: reference,
                newBalance: syncResult.newBalance,
                paystackData: paystackData.data
            });

        } else {
            console.log('❌ POST PayStack verification failed:', paystackData.data?.gateway_response);
            
            res.status(400).json({
                success: false,
                message: paystackData.data?.gateway_response || 'Payment verification failed',
                gatewayResponse: paystackData.data
            });
        }

    } catch (error) {
        console.error('💥 POST PayStack verification error:', error.response?.data || error.message);

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

// ✅ ENHANCED: Sync with main backend function
async function _syncWithMainBackend(userId, amount, reference) {
    try {
        console.log(`🔄 Syncing payment with main backend: ${reference} for user: ${userId}`);
        
        const syncResponse = await axios.post(
            `${MAIN_BACKEND_URL}/api/wallet/top-up`,
            {
                userId: userId,
                amount: amount,
                reference: reference,
                source: 'paystack_funding',
                description: 'Wallet funding via PayStack'
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        if (syncResponse.data.success) {
            console.log('✅ Main backend sync successful');
            return {
                success: true,
                newBalance: syncResponse.data.newBalance
            };
        } else {
            throw new Error(syncResponse.data.message || 'Main backend sync failed');
        }
    } catch (error) {
        console.error('❌ Main backend sync failed:', error.response?.data || error.message);
        
        return {
            success: false,
            error: error.response?.data?.message || error.message,
            newBalance: 0
        };
    }
}

// ✅ ADDED: Wallet balance endpoint
router.get('/wallet/balance/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        console.log(`💰 Getting wallet balance for user: ${userId}`);

        const balanceResponse = await axios.get(
            `${MAIN_BACKEND_URL}/api/users/balance/${userId}`,
            {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        res.json({
            success: true,
            walletBalance: balanceResponse.data.walletBalance,
            userId: userId,
            lastUpdated: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Wallet balance fetch error:', error.response?.data || error.message);
        
        res.status(500).json({
            success: false,
            message: 'Failed to fetch wallet balance',
            error: error.response?.data?.message || error.message
        });
    }
});

// ✅ ADDED: Wallet top-up endpoint
router.post('/wallet/top-up', async (req, res) => {
    try {
        const { userId, amount, reference, source, description } = req.body;

        console.log(`💰 Topping up wallet: ₦${amount} for user: ${userId}`);

        if (!userId || !amount || !reference) {
            return res.status(400).json({
                success: false,
                message: 'userId, amount, and reference are required'
            });
        }

        const walletUpdateResponse = await axios.post(
            `${MAIN_BACKEND_URL}/api/wallet/top-up`,
            {
                userId: userId,
                amount: amount,
                reference: reference,
                source: source || 'paystack_funding',
                description: description || 'Wallet funding'
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        res.json({
            success: true,
            message: 'Wallet topped up successfully',
            amount: amount,
            newBalance: walletUpdateResponse.data.newBalance,
            transactionId: walletUpdateResponse.data.transactionId,
            reference: reference
        });

    } catch (error) {
        console.error('❌ Wallet top-up error:', error.response?.data || error.message);
        
        res.status(500).json({
            success: false,
            message: 'Wallet top-up failed',
            error: error.response?.data?.message || error.message
        });
    }
});

// ✅ Sync successful payment with main backend
router.post('/sync-success', async (req, res) => {
    try {
        const { userId, reference, amount, paystackData } = req.body;

        console.log('🔄 Syncing successful payment:', { userId, reference, amount });

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

// ✅ Initialize PayStack payment with updated callback URL
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
                amount: amount * 100,
                reference: reference,
                currency: 'NGN',
                callback_url: 'https://virtual-account-backend.onrender.com/api/payments/verify?redirect=true',
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

router.get('/success', (req, res) => {
  const filePath = path.join(__dirname, '../public/payment-success.html');
  res.sendFile(filePath, err => {
    if (err) {
      console.error('Error sending success page:', err);
      res.status(404).send('Success page not found');
    }
  });
});

module.exports = router;
