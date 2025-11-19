// routes/wallet.js - Complete version with virtual account support
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Transaction = require('../models/Transaction');

// ✅ Wallet top-up endpoint for payment verification
router.post('/top-up', async (req, res) => {
    try {
        const { userId, amount, reference, source, description } = req.body;

        console.log('💰 Wallet top-up request:', { userId, amount, reference });

        if (!userId || !amount || !reference) {
            return res.status(400).json({
                success: false,
                message: 'userId, amount, and reference are required'
            });
        }

        // Find user
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Check if transaction already exists
        const existingTransaction = await Transaction.findOne({
            reference: reference,
            type: 'wallet_funding'
        });

        if (existingTransaction) {
            console.log('⚠️ Transaction already processed:', reference);
            return res.json({
                success: true,
                message: 'Payment already processed',
                newBalance: user.walletBalance,
                transactionId: existingTransaction._id
            });
        }

        // Update wallet balance
        const oldBalance = user.walletBalance;
        user.walletBalance += parseFloat(amount);
        await user.save();

        // FIXED: Use correct enum values
        const transaction = new Transaction({
            userId: userId,
            type: 'wallet_funding', // This exists in the enum
            amount: parseFloat(amount),
            reference: reference,
            status: 'success', // This exists in the enum
            description: description || 'Wallet funding',
            previousBalance: oldBalance,
            newBalance: user.walletBalance,
            source: source || 'paystack_funding',
            gateway: 'paystack'
        });

        await transaction.save();

        console.log('✅ Wallet topped up successfully:', {
            userId: userId,
            amount: amount,
            oldBalance: oldBalance,
            newBalance: user.walletBalance
        });

        res.json({
            success: true,
            message: 'Wallet topped up successfully',
            amount: amount,
            newBalance: user.walletBalance,
            transactionId: transaction._id
        });

    } catch (error) {
        console.error('💥 Wallet top-up error:', error);
        res.status(500).json({
            success: false,
            message: 'Wallet top-up failed: ' + error.message
        });
    }
});

// ✅ Virtual account top-up endpoint for webhook transfers
router.post('/virtual-account-topup', async (req, res) => {
    try {
        const { userId, amount, reference, description, source } = req.body;

        console.log('💰 Virtual account top-up request:', { userId, amount, reference });

        if (!userId || !amount || !reference) {
            return res.status(400).json({
                success: false,
                message: 'userId, amount, and reference are required'
            });
        }

        // Find user
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Check if transaction already exists to prevent double credit
        const existingTransaction = await Transaction.findOne({
            reference: reference,
            type: 'wallet_funding'
        });

        if (existingTransaction) {
            console.log('⚠️ Virtual account transaction already processed:', reference);
            return res.json({
                success: true,
                message: 'Virtual account payment already processed',
                newBalance: user.walletBalance,
                transactionId: existingTransaction._id
            });
        }

        // Update wallet balance
        const oldBalance = user.walletBalance;
        user.walletBalance += parseFloat(amount);
        await user.save();

        // Create transaction record for virtual account transfer
        const transaction = new Transaction({
            userId: userId,
            type: 'wallet_funding',
            amount: parseFloat(amount),
            reference: reference,
            status: 'completed',
            description: description || 'Virtual account deposit',
            previousBalance: oldBalance,
            newBalance: user.walletBalance,
            source: source || 'virtual_account_transfer',
            gateway: 'paystack_virtual_account',
            metadata: {
                source: 'virtual_account_webhook',
                transferType: 'virtual_account_deposit',
                processedAt: new Date().toISOString()
            }
        });

        await transaction.save();

        console.log('✅ Virtual account top-up successful:', {
            userId: userId,
            amount: amount,
            oldBalance: oldBalance,
            newBalance: user.walletBalance,
            reference: reference
        });

        res.json({
            success: true,
            message: 'Virtual account deposit processed successfully',
            amount: amount,
            newBalance: user.walletBalance,
            transactionId: transaction._id
        });

    } catch (error) {
        console.error('💥 Virtual account top-up error:', error);
        res.status(500).json({
            success: false,
            message: 'Virtual account top-up failed: ' + error.message
        });
    }
});

// ✅ Get wallet balance
router.get('/balance/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.json({
            success: true,
            walletBalance: user.walletBalance,
            userId: userId
        });

    } catch (error) {
        console.error('💥 Get balance error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get wallet balance: ' + error.message
        });
    }
});

// ✅ Emergency balance sync endpoint
router.post('/emergency-sync', async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID is required'
            });
        }

        // Get user
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Get all successful transactions for this user
        const transactions = await Transaction.find({
            userId,
            status: 'completed',
            type: 'wallet_funding'
        });

        // Calculate total balance from transactions
        let calculatedBalance = 0;
        transactions.forEach(transaction => {
            calculatedBalance += transaction.amount;
        });

        // Update user balance if different
        const balanceChanged = user.walletBalance !== calculatedBalance;
        if (balanceChanged) {
            const oldBalance = user.walletBalance;
            user.walletBalance = calculatedBalance;
            await user.save();

            console.log('✅ Emergency sync completed:', {
                userId: userId,
                oldBalance: oldBalance,
                newBalance: calculatedBalance,
                transactionsCount: transactions.length
            });

            res.json({
                success: true,
                message: 'Emergency sync completed - Balance corrected',
                oldBalance: oldBalance,
                newBalance: calculatedBalance,
                transactionsCount: transactions.length,
                balanceCorrected: true
            });
        } else {
            console.log('ℹ️ Emergency sync - Balance already correct:', user.walletBalance);
            res.json({
                success: true,
                message: 'Balance already correct',
                currentBalance: user.walletBalance,
                transactionsCount: transactions.length,
                balanceCorrected: false
            });
        }

    } catch (error) {
        console.error('💥 Emergency sync error:', error);
        res.status(500).json({
            success: false,
            message: 'Emergency sync failed: ' + error.message
        });
    }
});

// ✅ Force balance update endpoint (for manual corrections)
router.post('/force-update-balance', async (req, res) => {
    try {
        const { userId, newBalance, reason } = req.body;

        if (!userId || newBalance === undefined) {
            return res.status(400).json({
                success: false,
                message: 'userId and newBalance are required'
            });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const oldBalance = user.walletBalance;
        user.walletBalance = parseFloat(newBalance);
        await user.save();

        // Log the manual balance adjustment
        const transaction = new Transaction({
            userId: userId,
            type: 'balance_adjustment',
            amount: parseFloat(newBalance) - oldBalance,
            reference: `MANUAL_${Date.now()}`,
            status: 'completed',
            description: `Manual balance adjustment: ${reason || 'No reason provided'}`,
            previousBalance: oldBalance,
            newBalance: user.walletBalance,
            source: 'manual_correction',
            metadata: {
                adjustmentType: 'manual',
                reason: reason,
                processedBy: 'system_admin',
                processedAt: new Date().toISOString()
            }
        });

        await transaction.save();

        console.log('✅ Force balance update completed:', {
            userId: userId,
            oldBalance: oldBalance,
            newBalance: user.walletBalance,
            reason: reason
        });

        res.json({
            success: true,
            message: 'Balance force updated successfully',
            oldBalance: oldBalance,
            newBalance: user.walletBalance,
            adjustmentAmount: parseFloat(newBalance) - oldBalance,
            transactionId: transaction._id
        });

    } catch (error) {
        console.error('💥 Force balance update error:', error);
        res.status(500).json({
            success: false,
            message: 'Force balance update failed: ' + error.message
        });
    }
});

// ✅ Get wallet transactions
router.get('/transactions/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { limit = 50, page = 1, type } = req.query;

        const query = { userId };
        if (type) {
            query.type = type;
        }

        const transactions = await Transaction.find(query)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit))
            .skip((parseInt(page) - 1) * parseInt(limit));

        const totalTransactions = await Transaction.countDocuments(query);

        res.json({
            success: true,
            transactions: transactions,
            totalTransactions: totalTransactions,
            currentPage: parseInt(page),
            totalPages: Math.ceil(totalTransactions / parseInt(limit))
        });

    } catch (error) {
        console.error('💥 Get transactions error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get transactions: ' + error.message
        });
    }
});

// ✅ Health check endpoint
router.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'Wallet service is running',
        timestamp: new Date().toISOString(),
        endpoints: [
            'POST /top-up - Wallet top-up',
            'POST /virtual-account-topup - Virtual account deposits',
            'GET /balance/:userId - Get balance',
            'POST /emergency-sync - Emergency balance sync',
            'POST /force-update-balance - Force balance update',
            'GET /transactions/:userId - Get transactions'
        ]
    });
});

module.exports = router;
