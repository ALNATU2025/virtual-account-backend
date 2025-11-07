// routes/wallet.js
const express = require('express');
const router = express.Router();
const axios = require('axios');

// Main backend URL
const MAIN_BACKEND_URL = 'https://vtpass-backend.onrender.com';

// Get wallet balance
router.get('/balance/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        console.log(`💰 Getting wallet balance for user: ${userId}`);

        // Fetch balance from main backend
        const balanceResponse = await axios.get(
            `${MAIN_BACKEND_URL}/api/users/balance/${userId}`,
            {
                headers: {
                    'Content-Type': 'application/json'
                }
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

// Top up wallet
router.post('/top-up', async (req, res) => {
    try {
        const { userId, amount, reference, source, description } = req.body;

        if (!userId || !amount || !reference) {
            return res.status(400).json({
                success: false,
                message: 'userId, amount, and reference are required'
            });
        }

        console.log(`💰 Topping up wallet: ₦${amount} for user: ${userId}`);

        // Update balance in main backend
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
                }
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

module.exports = router;
