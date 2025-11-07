// routes/wallet.js - Add this to your main backend
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

        // Check if transaction already exists to prevent double credit
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

        // Create transaction record
        const transaction = new Transaction({
            userId: userId,
            type: 'wallet_funding',
            amount: parseFloat(amount),
            reference: reference,
            status: 'completed',
            description: description || 'Wallet funding',
            previousBalance: oldBalance,
            newBalance: user.walletBalance,
            source: source || 'paystack_funding'
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

module.exports = router;
