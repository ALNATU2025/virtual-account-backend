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

        // Validate required fields
        if (!userId || !email || !firstName || !lastName || !phone) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: userId, email, firstName, lastName, phone',
            });
        }

        // Check if virtual account already exists for this user
        const existingAccount = await VirtualAccount.findOne({ userId });
        if (existingAccount) {
            return res.status(409).json({
                success: false,
                message: 'Virtual account already exists for this user',
                accountNumber: existingAccount.accountNumber,
                accountName: existingAccount.accountName,
                bankName: existingAccount.bankName,
            });
        }

        // First, check if customer exists in Paystack, if not create one
        let customerCode;
        try {
            // Try to find existing customer
            const customerResponse = await axios.get(
                `https://api.paystack.co/customer?email=${encodeURIComponent(email)}`,
                {
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                    },
                    timeout: 10000, // 10 second timeout
                }
            );

            if (customerResponse.data.data && customerResponse.data.data.length > 0) {
                customerCode = customerResponse.data.data[0].customer_code;
                console.log(`✅ Found existing Paystack customer: ${customerCode}`);
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
                        timeout: 10000,
                    }
                );

                if (createCustomerResponse.data.status && createCustomerResponse.data.data) {
                    customerCode = createCustomerResponse.data.data.customer_code;
                    console.log(`✅ Created new Paystack customer: ${customerCode}`);
                } else {
                    throw new Error('Failed to create customer in Paystack');
                }
            }
        } catch (error) {
            console.error('Customer creation error:', error.response?.data || error.message);

            if (error.response?.status === 400 && error.response?.data?.message?.includes('already exists')) {
                // Customer already exists, try to fetch again
                try {
                    const retryResponse = await axios.get(
                        `https://api.paystack.co/customer?email=${encodeURIComponent(email)}`,
                        {
                            headers: {
                                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                            },
                            timeout: 10000,
                        }
                    );

                    if (retryResponse.data.data && retryResponse.data.data.length > 0) {
                        customerCode = retryResponse.data.data[0].customer_code;
                        console.log(`✅ Retrieved existing customer after conflict: ${customerCode}`);
                    } else {
                        throw new Error('Customer conflict but not found');
                    }
                } catch (retryError) {
                    return res.status(500).json({
                        success: false,
                        message: 'Failed to resolve customer conflict',
                        error: retryError.response?.data?.message || retryError.message,
                    });
                }
            } else {
                return res.status(500).json({
                    success: false,
                    message: 'Failed to create or retrieve customer',
                    error: error.response?.data?.message || error.message,
                });
            }
        }

        // Create Paystack dedicated virtual account
        try {
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
                    timeout: 15000, // 15 second timeout for virtual account creation
                }
            );

            if (paystackResponse.data.status && paystackResponse.data.data) {
                const virtualAccount = paystackResponse.data.data;

                // Save to database
                const newVirtualAccount = await VirtualAccount.create({
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

                console.log(`✅ Virtual account created successfully for user ${userId}: ${virtualAccount.account_number}`);

                res.json({
                    success: true,
                    accountNumber: virtualAccount.account_number,
                    accountName: virtualAccount.account_name,
                    bankName: virtualAccount.bank.name,
                    reference: virtualAccount.reference,
                    customerCode: customerCode,
                    message: 'Virtual account created successfully',
                });
            } else {
                throw new Error(paystackResponse.data.message || 'Failed to create virtual account');
            }
        } catch (paystackError) {
            console.error('Paystack virtual account creation error:', paystackError.response?.data || paystackError.message);

            // Handle specific Paystack errors
            if (paystackError.response?.status === 400) {
                const errorMessage = paystackError.response?.data?.message || 'Invalid request to Paystack';

                if (errorMessage.includes('Customer has already been assigned a dedicated account')) {
                    return res.status(409).json({
                        success: false,
                        message: 'Customer already has a virtual account assigned',
                    });
                }

                return res.status(400).json({
                    success: false,
                    message: errorMessage,
                });
            }

            throw paystackError; // Re-throw to be caught by outer catch
        }
    } catch (error) {
        console.error('Virtual account creation error:', error.response?.data || error.message);

        // Determine appropriate status code
        let statusCode = 500;
        let errorMessage = 'Failed to create virtual account';

        if (error.response?.status) {
            statusCode = error.response.status;
        }

        if (error.response?.data?.message) {
            errorMessage = error.response.data.message;
        } else if (error.message) {
            errorMessage = error.message;
        }

        // Handle specific error cases
        if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
            statusCode = 408;
            errorMessage = 'Virtual account service timeout. Please try again.';
        } else if (errorMessage.includes('Network Error') || errorMessage.includes('ENOTFOUND')) {
            statusCode = 503;
            errorMessage = 'Payment service temporarily unavailable.';
        }

        res.status(statusCode).json({
            success: false,
            message: errorMessage,
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
});

// Create instant virtual account endpoint (for new user registration)
router.post('/create-instant', async (req, res) => {
    try {
        const { userId, email, firstName, lastName, phone, preferredBank = 'wema-bank' } = req.body;

        console.log(`🚀 Creating instant virtual account for user: ${userId}`);

        // Validate required fields
        if (!userId || !email || !firstName || !lastName || !phone) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: userId, email, firstName, lastName, phone',
            });
        }

        // Check if virtual account already exists
        const existingAccount = await VirtualAccount.findOne({ userId });
        if (existingAccount) {
            console.log(`✅ Virtual account already exists for user ${userId}: ${existingAccount.accountNumber}`);
            return res.json({
                success: true,
                accountNumber: existingAccount.accountNumber,
                accountName: existingAccount.accountName,
                bankName: existingAccount.bankName,
                active: existingAccount.active,
                message: 'Virtual account already exists',
            });
        }

        // Create customer in Paystack
        let customerCode;
        try {
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
                    timeout: 10000,
                }
            );

            if (createCustomerResponse.data.status && createCustomerResponse.data.data) {
                customerCode = createCustomerResponse.data.data.customer_code;
                console.log(`✅ Created Paystack customer: ${customerCode}`);
            } else {
                throw new Error('Failed to create customer in Paystack');
            }
        } catch (error) {
            console.error('Customer creation error:', error.response?.data || error.message);

            // If customer already exists, try to fetch
            if (error.response?.status === 400 && error.response?.data?.message?.includes('already exists')) {
                try {
                    const customerResponse = await axios.get(
                        `https://api.paystack.co/customer?email=${encodeURIComponent(email)}`,
                        {
                            headers: {
                                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                            },
                            timeout: 10000,
                        }
                    );

                    if (customerResponse.data.data && customerResponse.data.data.length > 0) {
                        customerCode = customerResponse.data.data[0].customer_code;
                        console.log(`✅ Retrieved existing customer: ${customerCode}`);
                    } else {
                        throw new Error('Customer exists but not found');
                    }
                } catch (retryError) {
                    return res.status(500).json({
                        success: false,
                        message: 'Failed to resolve customer conflict',
                    });
                }
            } else {
                return res.status(500).json({
                    success: false,
                    message: 'Failed to create customer',
                });
            }
        }

        // Create dedicated virtual account
        try {
            const paystackResponse = await axios.post(
                'https://api.paystack.co/dedicated_account',
                {
                    customer: customerCode,
                    preferred_bank: preferredBank,
                },
                {
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 15000,
                }
            );

            if (paystackResponse.data.status && paystackResponse.data.data) {
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

                console.log(`✅ Instant virtual account created: ${virtualAccount.account_number}`);

                res.json({
                    success: true,
                    accountNumber: virtualAccount.account_number,
                    accountName: virtualAccount.account_name,
                    bankName: virtualAccount.bank.name,
                    active: true,
                    message: 'Virtual account created successfully',
                });
            } else {
                throw new Error(paystackResponse.data.message || 'Paystack API error');
            }
        } catch (paystackError) {
            console.error('Paystack virtual account error:', paystackError.response?.data || paystackError.message);

            // Handle customer already has account case gracefully
            if (paystackError.response?.data?.message?.includes('already been assigned')) {
                console.log(`ℹ️ Customer ${customerCode} already has virtual account`);

                // Try to get existing virtual account from Paystack
                try {
                    const accountsResponse = await axios.get(
                        `https://api.paystack.co/dedicated_account?customer=${customerCode}`,
                        {
                            headers: {
                                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                            },
                            timeout: 10000,
                        }
                    );

                    if (accountsResponse.data.data && accountsResponse.data.data.length > 0) {
                        const existingAccount = accountsResponse.data.data[0];

                        // Save to our database
                        await VirtualAccount.create({
                            userId,
                            accountNumber: existingAccount.account_number,
                            accountName: existingAccount.account_name,
                            bankName: existingAccount.bank.name,
                            bankCode: existingAccount.bank.id,
                            customerCode: customerCode,
                            assigned: true,
                            active: existingAccount.active,
                            paystackReference: existingAccount.reference,
                        });

                        return res.json({
                            success: true,
                            accountNumber: existingAccount.account_number,
                            accountName: existingAccount.account_name,
                            bankName: existingAccount.bank.name,
                            active: existingAccount.active,
                            message: 'Virtual account retrieved successfully',
                        });
                    }
                } catch (getError) {
                    console.error('Failed to get existing virtual account:', getError.message);
                }
            }

            return res.status(500).json({
                success: false,
                message: 'Failed to create virtual account',
            });
        }
    } catch (error) {
        console.error('Instant virtual account creation error:', error.response?.data || error.message);

        res.status(500).json({
            success: false,
            message: 'Virtual account service temporarily unavailable',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
});

// Get virtual account by user ID
router.get('/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID is required',
            });
        }

        const virtualAccount = await VirtualAccount.findOne({ userId });

        if (!virtualAccount) {
            return res.status(404).json({
                success: false,
                message: 'Virtual account not found for this user',
            });
        }

        res.json({
            success: true,
            accountNumber: virtualAccount.accountNumber,
            accountName: virtualAccount.accountName,
            bankName: virtualAccount.bankName,
            active: virtualAccount.active,
            assigned: virtualAccount.assigned,
            customerCode: virtualAccount.customerCode,
        });
    } catch (error) {
        console.error('Get virtual account error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get virtual account',
        });
    }
});

// Get virtual account for current user (using auth)
router.get('/user/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const virtualAccount = await VirtualAccount.findOne({ userId });

        if (!virtualAccount) {
            return res.status(404).json({
                success: false,
                message: 'Virtual account not found',
                hasAccount: false,
            });
        }

        res.json({
            success: true,
            accountNumber: virtualAccount.accountNumber,
            accountName: virtualAccount.accountName,
            bankName: virtualAccount.bankName,
            active: virtualAccount.active,
            hasAccount: true,
        });
    } catch (error) {
        console.error('Get user virtual account error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get virtual account details',
        });
    }
});

// Webhook for virtual account funding (unchanged, but with better error handling)
router.post('/webhook', async (req, res) => {
    try {
        const event = req.body;
        console.log(`🪙 Received webhook event: ${event.event}`);

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
