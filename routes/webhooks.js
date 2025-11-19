// routes/debug.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

// In-memory storage for incoming webhooks (for debugging)
let webhookLogs = [];

// Middleware to store incoming webhook events
router.post('/log-webhook', async (req, res) => {
    const eventData = req.body;
    const receivedAt = new Date();

    // Store only the last 100 webhooks to avoid memory issues
    webhookLogs.unshift({ eventData, receivedAt });
    if (webhookLogs.length > 100) webhookLogs.pop();

    console.log('🔔 Webhook logged for debug:', JSON.stringify(eventData, null, 2));

    res.status(200).json({ success: true, message: 'Webhook logged' });
});

// Endpoint to view recent webhook logs
router.get('/webhook-debug', async (req, res) => {
    try {
        const logsWithUser = await Promise.all(
            webhookLogs.map(async (log) => {
                let virtualAccountNumber = log.eventData.data?.recipient?.account_number;
                let user = null;
                if (virtualAccountNumber) {
                    user = await User.findOne({ virtualAccountNumber });
                }

                return {
                    receivedAt: log.receivedAt,
                    event: log.eventData.event,
                    reference: log.eventData.data?.reference || null,
                    amount: log.eventData.data?.amount ? log.eventData.data.amount / 100 : null,
                    virtualAccountNumber,
                    userEmail: user?.email || null,
                    walletBalance: user?.walletBalance || null,
                    rawEvent: log.eventData
                };
            })
        );

        res.json({
            success: true,
            logs: logsWithUser
        });
    } catch (error) {
        console.error('❌ Failed to get webhook debug logs:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch webhook debug logs',
            error: process.env.NODE_ENV === 'production' ? null : error.message
        });
    }
});

module.exports = router;
