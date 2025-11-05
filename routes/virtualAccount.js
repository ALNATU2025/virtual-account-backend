// routes/virtualAccount.js - COMPLETE FIXED VERSION
const express = require('express');
const router = express.Router();
const axios = require('axios');
const VirtualAccount = require('../models/VirtualAccount');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// Validate that keys are loaded
if (!PAYSTACK_SECRET_KEY) {
    console.error('❌ PAYSTACK_SECRET_KEY is not defined in environment variables');
}

// Get virtual account by user ID
router.get('/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        console.log(`🔍 Fetching virtual account for user: ${userId}`);

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID is required',
            });
        }

        const virtualAccount = await VirtualAccount.findOne({ userId });

        if (!virtualAccount) {
            console.log(`❌ Virtual account not found for user: ${userId}`);
            return res.status(404).json({
                success: false,
                message: 'Virtual account not found for this user',
                hasAccount: false,
            });
        }

        console.log(`✅ Virtual account found: ${virtualAccount.accountNumber}`);

        res.json({
            success: true,
            accountNumber: virtualAccount.accountNumber,
            accountName: virtualAccount.accountName,
            bankName: virtualAccount.bankName,
            active: virtualAccount.active,
            assigned: virtualAccount.assigned,
            customerCode: virtualAccount.customerCode,
            hasAccount: true,
        });
    } catch (error) {
        console.error('❌ Get virtual account error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get virtual account',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
});

// Health check endpoint
router.get('/health/status', async (req, res) => {
    try {
        res.json({
            success: true,
            message: 'Virtual account service is running',
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error('Health check error:', error);
        res.status(500).json({
            success: false,
            message: 'Service health check failed',
        });
    }
});

// FIXED: Create instant virtual account endpoint
router.post('/create-instant-account', async (req, res) => {
    try {
        const { userId, email, firstName, lastName, phone, preferredBank = 'wema-bank' } = req.body;

        console.log(`🚀 CREATE-INSTANT: Creating virtual account for user: ${userId}`);

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
                customerCode: existingAccount.customerCode,
                message: 'Virtual account already exists',
            });
        }

        // Create or get customer
        let customerCode;
        try {
            // Try to find existing customer first
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
                console.log(`✅ Found existing customer: ${customerCode}`);
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
                    console.log(`✅ Created new customer: ${customerCode}`);
                } else {
                    throw new Error('Failed to create customer');
                }
            }
        } catch (error) {
            console.error('Customer creation error:', error.response?.data || error.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to create or retrieve customer',
            });
        }

        // Create virtual account
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

                // ✅ FIX: Generate paystackReference if missing from Paystack response
                const paystackReference = virtualAccount.reference || `REF_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

                console.log(`💰 Paystack virtual account created:`, {
                    account_number: virtualAccount.account_number,
                    reference: paystackReference,
                    customer_code: customerCode
                });

                // ✅ FIX: Save to database with ALL required fields
                const newVirtualAccount = new VirtualAccount({
                    userId: userId,
                    accountNumber: virtualAccount.account_number,
                    accountName: virtualAccount.account_name,
                    bankName: virtualAccount.bank.name,
                    bankCode: virtualAccount.bank.id.toString(),
                    customerCode: customerCode,
                    assigned: true,
                    active: true,
                    paystackReference: paystackReference // ✅ This is now provided
                });

                await newVirtualAccount.save();

                console.log(`✅ Virtual account saved to database: ${virtualAccount.account_number}`);

                return res.json({
                    success: true,
                    accountNumber: virtualAccount.account_number,
                    accountName: virtualAccount.account_name,
                    bankName: virtualAccount.bank.name,
                    active: true,
                    customerCode: customerCode,
                    message: 'Virtual account created successfully',
                });
            } else {
                throw new Error(paystackResponse.data.message || 'Paystack API error');
            }
        } catch (paystackError) {
            console.error('Paystack virtual account error:', paystackError.response?.data || paystackError.message);

            // Handle case where customer already has virtual account
            if (paystackError.response?.data?.message?.includes('already been assigned')) {
                console.log(`ℹ️ Customer already has virtual account, retrieving...`);

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
                        const existingPaystackAccount = accountsResponse.data.data[0];

                        // ✅ FIX: Generate paystackReference for existing account
                        const paystackReference = existingPaystackAccount.reference || `REF_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

                        // Save to our database
                        const newVirtualAccount = new VirtualAccount({
                            userId: userId,
                            accountNumber: existingPaystackAccount.account_number,
                            accountName: existingPaystackAccount.account_name,
                            bankName: existingPaystackAccount.bank.name,
                            bankCode: existingPaystackAccount.bank.id.toString(),
                            customerCode: customerCode,
                            assigned: true,
                            active: existingPaystackAccount.active,
                            paystackReference: paystackReference // ✅ This is now provided
                        });

                        await newVirtualAccount.save();

                        console.log(`✅ Existing virtual account saved: ${existingPaystackAccount.account_number}`);

                        return res.json({
                            success: true,
                            accountNumber: existingPaystackAccount.account_number,
                            accountName: existingPaystackAccount.account_name,
                            bankName: existingPaystackAccount.bank.name,
                            active: existingPaystackAccount.active,
                            customerCode: customerCode,
                            message: 'Virtual account retrieved successfully',
                        });
                    }
                } catch (getError) {
                    console.error('Failed to get existing account:', getError.message);
                }
            }

            return res.status(500).json({
                success: false,
                message: 'Failed to create virtual account: ' + (paystackError.response?.data?.message || paystackError.message),
            });
        }
    } catch (error) {
        console.error('Instant virtual account creation error:', error);
        res.status(500).json({
            success: false,
            message: 'Virtual account service temporarily unavailable: ' + error.message,
        });
    }
});

// Add this route to fix existing users with missing paystackReference
router.post('/fix-missing-references', async (req, res) => {
    try {
        // Find all virtual accounts missing paystackReference or with invalid ones
        const brokenAccounts = await VirtualAccount.find({
            $or: [
                { paystackReference: { $exists: false } },
                { paystackReference: null },
                { paystackReference: '' }
            ]
        });

        console.log(`🔧 Found ${brokenAccounts.length} accounts with missing paystackReference`);

        let fixedCount = 0;
        
        for (const account of brokenAccounts) {
            try {
                // Generate a unique reference
                const newReference = `FIXED_REF_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                
                account.paystackReference = newReference;
                await account.save();
                
                console.log(`✅ Fixed account ${account.accountNumber} for user ${account.userId}`);
                fixedCount++;
            } catch (saveError) {
                console.error(`❌ Failed to fix account ${account.accountNumber}:`, saveError.message);
            }
        }

        res.json({
            success: true,
            message: `Fixed ${fixedCount} out of ${brokenAccounts.length} accounts with missing references`,
            fixedCount: fixedCount,
            totalFound: brokenAccounts.length
        });

    } catch (error) {
        console.error('Error fixing missing references:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fix missing references: ' + error.message
        });
    }
});

module.exports = router;
