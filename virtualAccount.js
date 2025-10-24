const express = require('express');
const router = express.Router();
const axios = require('axios');
const VirtualAccount = require('../models/VirtualAccount');

// Use your Paystack secret key directly
const PAYSTACK_SECRET_KEY = 'sk_test_bda38e781c1781083e6ca116c48cc52609205da3';

// Create virtual account for user
router.post('/create', async (req, res) => {
    try {
        const { userId, email, firstName, lastName, phone } = req.body;

        // First, check if customer exists in Paystack, if not create one
        let customerCode;
        try {
            // Try to find existing customer
            const customerResponse = await axios.get(
                `https://api.paystack.co/customer?email=${email}`,
                {
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                    },
                }
            );

            if (customerResponse.data.data && customerResponse.data.data.length > 0) {
                customerCode = customerResponse.data.data[0].customer_code;
            } else {
                // Create new customer
                const createCustomerResponse = await axios.post(
                    'https://api.paystack.co/customer',
                    {
                        email: email,
                        first_name: firstName,
                        last_name: lastName,
                        phone: phone,
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                            'Content-Type': 'application/json',
                        },
                    }
                );
                customerCode = createCustomerResponse.data.data.customer_code;
            }
        } catch (error) {
            console.error('Customer creation error:', error);
            return res.status(500).json({
                success: false,
                message: 'Failed to create customer',
            });
        }

        // Create Paystack dedicated virtual account
        const paystackResponse = await axios.post(
            'https://api.paystack.co/dedicated_account',
            {
                customer: customerCode,
                preferred_bank: "wema-bank",
            },
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        if (paystackResponse.data.status) {
            const virtualAccount = paystackResponse.data.data;

            // Save to database
            await VirtualAccount.create({
                userId,
                accountNumber: virtualAccount.account_number,
                accountName: virtualAccount.account_name,
                bankName: virtualAccount.bank.name,
                bankCode: virtualAccount.bank.id,
                customerCode: customerCode,
                assigned: true,
                active: true,
                paystackReference: virtualAccount.reference,
            });

            res.json({
                success: true,
                accountNumber: virtualAccount.account_number,
                accountName: virtualAccount.account_name,
                bankName: virtualAccount.bank.name,
                reference: virtualAccount.reference,
            });
        } else {
            throw new Error(paystackResponse.data.message);
        }
    } catch (error) {
        console.error('Virtual account creation error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create virtual account',
        });
    }
});

// Get virtual account by user ID
router.get('/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const virtualAccount = await VirtualAccount.findOne({ userId });

        if (!virtualAccount) {
            return res.status(404).json({
                success: false,
                message: 'Virtual account not found',
            });
        }

        res.json({
            success: true,
            accountNumber: virtualAccount.accountNumber,
            accountName: virtualAccount.accountName,
            bankName: virtualAccount.bankName,
            active: virtualAccount.active,
        });
    } catch (error) {
        console.error('Get virtual account error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get virtual account',
        });
    }
});

// Webhook for virtual account funding
router.post('/webhook', async (req, res) => {
    try {
        const event = req.body;

        if (event.event === 'charge.success') {
            const transaction = event.data;

            // Find virtual account by account number
            const virtualAccount = await VirtualAccount.findOne({
                accountNumber: transaction.account_number,
            });

            if (virtualAccount && virtualAccount.userId) {
                // Update user's wallet balance
                const User = require('../models/User');
                const user = await User.findById(virtualAccount.userId);

                if (user) {
                    const amount = transaction.amount / 100;
                    const newBalance = (user.walletBalance || 0) + amount;

                    await User.findByIdAndUpdate(virtualAccount.userId, {
                        walletBalance: newBalance,
                    });

                    // Create transaction record
                    const Transaction = require('../models/Transaction');
                    await Transaction.create({
                        userId: virtualAccount.userId,
                        amount: amount,
                        type: 'credit',
                        description: 'Virtual Account Funding',
                        status: 'completed',
                        reference: transaction.reference,
                        balanceAfter: newBalance,
                    });

                    console.log(`💰 Wallet updated for user ${user.email}: +₦${amount}`);
                }
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(400);
    }
});

module.exports = router;