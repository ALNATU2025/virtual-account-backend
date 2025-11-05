const express = require('express');
const router = express.Router();
const axios = require('axios');
const VirtualAccount = require('../models/VirtualAccount');

// ✅ SECURE: Use environment variables instead of hardcoded keys
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY;

// Validate that keys are loaded
if (!PAYSTACK_SECRET_KEY) {
    console.error('❌ PAYSTACK_SECRET_KEY is not defined in environment variables');
}

// Get virtual account by user ID (compatible with Flutter app)
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

// Enhanced create endpoint with better error handling
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
