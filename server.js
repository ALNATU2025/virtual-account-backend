const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { body, validationResult } = require('express-validator');
require('dotenv').config();

const app = express();


// ==================== SYNC WITH MAIN BACKEND ====================
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'https://vtpass-backend.onrender.com';

// FIXED & WORKING sync function
async function syncVirtualAccountTransferWithMainBackend(userId, amountInNaira, reference) {
  if (!MAIN_BACKEND_URL) {
    console.error('⚠️ MAIN_BACKEND_URL not set in .env');
    return;
  }

  try {
    console.log('🔄 Syncing virtual account deposit to main backend:', {
      userId,
      amountInNaira,
      reference,
      url: `${MAIN_BACKEND_URL}/api/wallet/top-up`
    });

    const response = await fetch(`${MAIN_BACKEND_URL}/api/wallet/top-up`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: userId.toString(),
        amount: amountInNaira,           // already in Naira
        reference: reference,
        description: `Virtual account deposit - ${reference}`,
        source: 'virtual_account_webhook'
      }),
      timeout: 15000
    });

    const result = await response.json();

    if (response.ok && result.success) {
      console.log('✅ Successfully synced to main backend:', result.newBalance);
    } else {
      console.error('❌ Main backend sync failed:', result.message || response.status);
    }
  } catch (err) {
    console.error('❌ Exception during main backend sync:', err.message);
  }
}

// ALLOW ALL ORIGINS - Simple CORS fix
app.use(cors({
  origin: true, // Allow all origins
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type',
    'Authorization', 
    'X-Requested-With',
    'Accept',
    'Origin',
    'X-Request-ID',
    'X-Client-Version',
    'X-Client-Platform',
    'X-User-ID',
  ],
}));

// Handle preflight requests
app.options('*', cors());

// Other middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Import models from their separate files
const Transaction = require('./models/Transaction');
const User = require('./models/User');

// Import routes (files are available)
const virtualAccountRoutes = require('./routes/virtualAccount');
const webhookRoutes = require('./routes/webhooks');
const paymentRoutes = require('./routes/payments');
const walletRoutes = require('./routes/wallet');

// Mount routes
app.use('/api/virtual-accounts', virtualAccountRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/wallet', walletRoutes);

console.log('✅ All routes mounted successfully');

// PayStack proxy endpoint - Simple version
app.post('/api/payments/verify-paystack', async (req, res) => {
  // Enable CORS
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  try {
    const { reference } = req.body;
    
    if (!reference) {
      return res.status(400).json({
        success: false,
        message: 'Reference is required'
      });
    }

    console.log('🔍 CORS Proxy: Verifying PayStack transaction:', reference);

    // Call PayStack API from backend (no CORS issues)
    const paystackResponse = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await paystackResponse.json();
    
    console.log('📡 CORS Proxy PayStack response:', data.status);

    if (data.status && data.data && data.data.status === 'success') {
      res.json({
        success: true,
        status: data.data.status,
        amount: data.data.amount / 100,
        reference: data.data.reference,
        paidAt: data.data.paid_at,
        message: 'Payment verified successfully via CORS proxy',
        source: 'cors_proxy_backend'
      });
    } else {
      res.json({
        success: false,
        message: data.message || 'Payment verification failed',
        status: data.data?.status || 'unknown'
      });
    }

  } catch (error) {
    console.error('❌ CORS Proxy error:', error);
    res.status(500).json({
      success: false,
      message: 'CORS proxy service temporarily unavailable',
      error: process.env.NODE_ENV === 'production' ? null : error.message
    });
  }
});


// ENHANCED: PayStack verification with database duplicate protection
app.post('/api/payments/verify-paystack-enhanced', [
  body('reference').notEmpty().withMessage('Reference is required'),
  body('userId').isMongoId().withMessage('Valid user ID required') // Changed from optional to required
], async (req, res) => {
  // Enable CORS
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: errors.array()[0].msg
    });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { reference, userId } = req.body;
    
    console.log('🔍 ENHANCED VERIFICATION: Checking reference:', reference, 'for user:', userId);

    // ✅ CRITICAL: Database-level duplicate check
    const existingTransaction = await Transaction.findOne({
      reference: reference,
      status: 'success'
    }).session(session);

    if (existingTransaction) {
      await session.abortTransaction();
      console.log('✅ DATABASE: Transaction already processed:', reference);
      
      // Get current user balance
      let currentBalance = 0;
      if (userId) {
        const user = await User.findById(userId);
        currentBalance = user ? user.walletBalance : 0;
      }
      
      return res.json({
        success: false,
        message: 'This transaction was already verified and processed',
        alreadyProcessed: true,
        amount: existingTransaction.amount,
        newBalance: currentBalance,
        transactionId: existingTransaction._id,
        databaseProtected: true
      });
    }

    console.log('🔍 CORS Proxy: Verifying PayStack transaction:', reference);

    // Call PayStack API from backend (no CORS issues)
    const paystackResponse = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await paystackResponse.json();
    
    console.log('📡 CORS Proxy PayStack response:', data.status);

    if (data.status && data.data && data.data.status === 'success') {
      const amount = data.data.amount / 100;
      const customerEmail = data.data.customer?.email;
      
      // ✅ SECURITY CHECK: Verify transaction belongs to this user
      if (userId) {
        const user = await User.findById(userId).session(session);
        if (!user) {
          await session.abortTransaction();
          return res.status(404).json({
            success: false,
            message: 'User not found'
          });
        }

        // 🔒 CRITICAL SECURITY CHECK: Verify transaction email matches user email
        if (customerEmail && customerEmail.toLowerCase() !== user.email.toLowerCase()) {
          await session.abortTransaction();
          console.log('🚨 SECURITY ALERT: Transaction email mismatch:', {
            transactionEmail: customerEmail,
            userEmail: user.email,
            reference: reference,
            userId: userId
          });
          
          return res.status(403).json({
            success: false,
            message: 'This transaction does not belong to you. Please use transactions initiated with your account.',
            securityViolation: true,
            emailMismatch: true
          });
        }

        const balanceBefore = user.walletBalance;
        user.walletBalance += amount;
        const balanceAfter = user.walletBalance;
        
        await user.save({ session });

        // ✅ Create transaction record with UNIQUE reference
        try {
          const transaction = await Transaction.create([{
            userId: userId,
            type: 'wallet_funding',
            amount: amount,
            status: 'success',
            reference: reference,
            gateway: 'paystack',
            description: `Wallet funding via PayStack - Ref: ${reference}`,
            metadata: {
              source: 'paystack_proxy',
              verifiedAt: new Date(),
              customerEmail: customerEmail,
              balanceBefore: balanceBefore,
              balanceAfter: balanceAfter,
              balanceUpdated: true,
              paystackData: {
                paidAt: data.data.paid_at,
                channel: data.data.channel,
                currency: data.data.currency,
                customer: data.data.customer
              }
            }
          }], { session });

          await session.commitTransaction();

          console.log('✅ ENHANCED VERIFICATION COMPLETE:', {
            reference,
            amount,
            newBalance: balanceAfter,
            transactionId: transaction[0]._id,
            userEmail: user.email
          });

          res.json({
            success: true,
            status: data.data.status,
            amount: amount,
            reference: data.data.reference,
            paidAt: data.data.paid_at,
            newBalance: balanceAfter,
            message: 'Payment verified successfully with database protection',
            source: 'enhanced_cors_proxy',
            transactionId: transaction[0]._id
          });

        } catch (dbError) {
          // ✅ Handle duplicate key error
          if (dbError.code === 11000 || dbError.message.includes('duplicate key')) {
            await session.abortTransaction();
            console.log('✅ DATABASE UNIQUE CONSTRAINT: Transaction already exists');
            
            const user = await User.findById(userId);
            const currentBalance = user ? user.walletBalance : 0;
            
            return res.json({
              success: false,
              message: 'Transaction was already processed in database',
              alreadyProcessed: true,
              amount: amount,
              newBalance: currentBalance,
              databaseConstraint: true
            });
          }
          throw dbError;
        }
      } else {
        // No userId provided - just return verification without database update
        await session.commitTransaction();
        
        res.json({
          success: true,
          status: data.data.status,
          amount: amount,
          reference: data.data.reference,
          paidAt: data.data.paid_at,
          message: 'Payment verified successfully (no balance update - user ID required)',
          source: 'cors_proxy_backend',
          needsUserId: true
        });
      }
    } else {
      await session.abortTransaction();
      res.json({
        success: false,
        message: data.message || 'Payment verification failed',
        status: data.data?.status || 'unknown'
      });
    }

  } catch (error) {
    await session.abortTransaction();
    console.error('❌ ENHANCED CORS Proxy error:', error);
    
    // Handle duplicate key error from transaction
    if (error.code === 11000 || error.message.includes('duplicate key')) {
      return res.json({
        success: false,
        message: 'Transaction was already processed',
        alreadyProcessed: true,
        databaseConstraint: true
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Enhanced verification service temporarily unavailable',
      error: process.env.NODE_ENV === 'production' ? null : error.message
    });
  } finally {
    session.endSession();
  }
});


// In server.js - FIXED Virtual Account Webhook
app.post('/api/webhooks/virtual-account', async (req, res) => {
  console.log('🔔 Virtual Account Webhook Received:', JSON.stringify(req.body, null, 2));
  
  // IMMEDIATE RESPONSE to prevent PayStack retries
  res.status(200).json({ success: true, message: 'Webhook received' });

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { event, data } = req.body;
    
    if (event === 'transfer.success') {
      const { reference, amount, recipient, sender } = data;
      const virtualAccountNumber = recipient?.account_number;

      console.log('💳 Virtual Account Transfer Webhook:', {
        reference,
        amount: amount / 100,
        virtualAccountNumber
      });

      if (!virtualAccountNumber) {
        console.log('❌ No virtual account number in transfer data');
        await session.abortTransaction();
        return;
      }

      // Find user by virtual account number
      const user = await User.findOne({
        virtualAccountNumber: virtualAccountNumber
      }).session(session);

      if (!user) {
        console.log('❌ User not found for virtual account:', virtualAccountNumber);
        await session.abortTransaction();
        return;
      }

      // Check if transaction already exists
      const existingTransaction = await Transaction.findOne({
        reference: reference
      }).session(session);

      if (existingTransaction && existingTransaction.status === 'success') {
        console.log('✅ Transaction already processed:', reference);
        await session.abortTransaction();
        return;
      }

      const amountInNaira = amount / 100;
      const balanceBefore = user.walletBalance;
      user.walletBalance += amountInNaira;
      const balanceAfter = user.walletBalance;

      await user.save({ session });

      // FIXED: Use correct enum values for this Transaction model
      const transactionData = {
        userId: user._id.toString(),
        type: 'virtual_account_deposit', // Use the new enum value
        amount: amountInNaira,
        status: 'success', // This exists in the enum
        reference: reference,
        gateway: 'paystack_virtual_account', // This exists in the enum
        description: `Virtual account deposit - ${virtualAccountNumber}`,
        balanceBefore: balanceBefore,
        balanceAfter: balanceAfter,
        metadata: {
          source: 'virtual_account_webhook',
          verifiedAt: new Date(),
          virtualAccountNumber: virtualAccountNumber,
          balanceUpdated: true,
          sender: sender?.name || 'Unknown',
          bank: recipient?.bank?.name,
          webhookData: data
        }
      };

      const transaction = await Transaction.create([transactionData], { session });

      await session.commitTransaction();

      console.log('✅ Virtual Account Transfer Processed:', {
        reference,
        amount: amountInNaira,
        user: user.email,
        newBalance: balanceAfter,
        virtualAccount: virtualAccountNumber
      });

      // Sync with main backend (non-blocking)
      try {
        await syncVirtualAccountTransferWithMainBackend(user._id, amountInNaira, reference);
      } catch (syncError) {
        console.error('⚠️ Sync failed but balance updated:', syncError.message);
      }

    } else {
      console.log(`ℹ️ Other webhook event: ${event}`);
      await session.commitTransaction();
    }

  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Virtual Account Webhook Error:', error);
  } finally {
    session.endSession();
  }
});


// ENHANCED: PayStack verification with database duplicate protection
app.post('/api/payments/verify-paystack-enhanced', [
  body('reference').notEmpty().withMessage('Reference is required'),
  body('userId').optional().isMongoId().withMessage('Valid user ID required')
], async (req, res) => {
  // Enable CORS
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: errors.array()[0].msg
    });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { reference, userId } = req.body;
    
    console.log('🔍 ENHANCED VERIFICATION: Checking reference:', reference);

    // ✅ CRITICAL: Database-level duplicate check
    const existingTransaction = await Transaction.findOne({
      reference: reference,
      status: 'success' // Changed from 'successful' to 'success'
    }).session(session);

    if (existingTransaction) {
      await session.abortTransaction();
      console.log('✅ DATABASE: Transaction already processed:', reference);
      
      // Get current user balance
      let currentBalance = 0;
      if (userId) {
        const user = await User.findById(userId);
        currentBalance = user ? user.walletBalance : 0;
      }
      
      return res.json({
        success: false,
        message: 'This transaction was already verified and processed',
        alreadyProcessed: true,
        amount: existingTransaction.amount,
        newBalance: currentBalance,
        transactionId: existingTransaction._id,
        databaseProtected: true
      });
    }

    console.log('🔍 CORS Proxy: Verifying PayStack transaction:', reference);

    // Call PayStack API from backend (no CORS issues)
    const paystackResponse = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await paystackResponse.json();
    
    console.log('📡 CORS Proxy PayStack response:', data.status);

    if (data.status && data.data && data.data.status === 'success') {
      const amount = data.data.amount / 100;
      
      // ✅ Only update database if userId is provided
      if (userId) {
        const user = await User.findById(userId).session(session);
        if (!user) {
          await session.abortTransaction();
          return res.status(404).json({
            success: false,
            message: 'User not found'
          });
        }

        const balanceBefore = user.walletBalance;
        user.walletBalance += amount;
        const balanceAfter = user.walletBalance;
        
        await user.save({ session });

        // ✅ Create transaction record with UNIQUE reference - USING CORRECT ENUM VALUES
        try {
          const transaction = await Transaction.create([{
            userId: userId,
            type: 'wallet_funding', // Changed from 'credit' to 'wallet_funding'
            amount: amount,
            status: 'success', // Changed from 'successful' to 'success'
            reference: reference,
            gateway: 'paystack',
            description: `Wallet funding via PayStack - Ref: ${reference}`,
            metadata: {
              source: 'paystack_proxy',
              verifiedAt: new Date(),
              customerEmail: data.data.customer?.email,
              balanceBefore: balanceBefore,
              balanceAfter: balanceAfter,
              balanceUpdated: true,
              paystackData: {
                paidAt: data.data.paid_at,
                channel: data.data.channel,
                currency: data.data.currency
              }
            }
          }], { session });

          await session.commitTransaction();

          console.log('✅ ENHANCED VERIFICATION COMPLETE:', {
            reference,
            amount,
            newBalance: balanceAfter,
            transactionId: transaction[0]._id
          });

          res.json({
            success: true,
            status: data.data.status,
            amount: amount,
            reference: data.data.reference,
            paidAt: data.data.paid_at,
            newBalance: balanceAfter,
            message: 'Payment verified successfully with database protection',
            source: 'enhanced_cors_proxy',
            transactionId: transaction[0]._id
          });

        } catch (dbError) {
          // ✅ Handle duplicate key error
          if (dbError.code === 11000 || dbError.message.includes('duplicate key')) {
            await session.abortTransaction();
            console.log('✅ DATABASE UNIQUE CONSTRAINT: Transaction already exists');
            
            const user = await User.findById(userId);
            const currentBalance = user ? user.walletBalance : 0;
            
            return res.json({
              success: false,
              message: 'Transaction was already processed in database',
              alreadyProcessed: true,
              amount: amount,
              newBalance: currentBalance,
              databaseConstraint: true
            });
          }
          throw dbError;
        }
      } else {
        // No userId provided - just return verification without database update
        await session.commitTransaction();
        
        res.json({
          success: true,
          status: data.data.status,
          amount: amount,
          reference: data.data.reference,
          paidAt: data.data.paid_at,
          message: 'Payment verified successfully (no balance update - user ID required)',
          source: 'cors_proxy_backend',
          needsUserId: true
        });
      }
    } else {
      await session.abortTransaction();
      res.json({
        success: false,
        message: data.message || 'Payment verification failed',
        status: data.data?.status || 'unknown'
      });
    }

  } catch (error) {
    await session.abortTransaction();
    console.error('❌ ENHANCED CORS Proxy error:', error);
    
    // Handle duplicate key error from transaction
    if (error.code === 11000 || error.message.includes('duplicate key')) {
      return res.json({
        success: false,
        message: 'Transaction was already processed',
        alreadyProcessed: true,
        databaseConstraint: true
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Enhanced verification service temporarily unavailable',
      error: process.env.NODE_ENV === 'production' ? null : error.message
    });
  } finally {
    session.endSession();
  }
});

// Check if transaction reference exists in database
app.get('/api/payments/check-reference/:reference', async (req, res) => {
  // Enable CORS
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  try {
    const { reference } = req.params;
    const { userId } = req.query;

    console.log('🔍 DATABASE CHECK: Verifying reference:', reference);

    const transaction = await Transaction.findOne({ 
      reference: reference
    });

    if (!transaction) {
      return res.json({
        exists: false,
        message: 'Transaction reference not found in database'
      });
    }

    // Check if user owns this transaction (if userId provided)
    const userOwnsTransaction = userId ? transaction.userId.toString() === userId : true;

    res.json({
      exists: true,
      userOwnsTransaction: userOwnsTransaction,
      alreadyProcessed: transaction.status === 'success', // Changed from 'successful' to 'success'
      transaction: {
        _id: transaction._id,
        amount: transaction.amount,
        status: transaction.status,
        createdAt: transaction.createdAt,
        userId: transaction.userId,
        type: transaction.type,
        description: transaction.description
      },
      message: transaction.status === 'success' 
        ? 'Transaction already processed successfully' 
        : `Transaction is ${transaction.status}`
    });

  } catch (error) {
    console.error('Error checking transaction reference:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check transaction reference'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Virtual Account Backend is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    cors: 'Enabled - All origins allowed'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Virtual Account Backend is running successfully',
    version: '1.0.0',
    cors: 'Enabled - All origins allowed',
    webhook_url: 'https://virtual-account-backend.onrender.com/api/webhooks/paystack',
    paystack_proxy: 'https://virtual-account-backend.onrender.com/api/payments/verify-paystack',
    endpoints: {
      simple_verification: '/api/payments/verify-paystack',
      enhanced_verification: '/api/payments/verify-paystack-enhanced',
      check_reference: '/api/payments/check-reference/:reference',
      health: '/health'
    }
  });
});

// Handle 404 errors
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`
  });
});


// ================= DEBUG WEBHOOK LOGGING ==================

// In-memory storage for last 100 webhook events
let webhookLogs = [];

// Endpoint to log incoming webhooks for debugging (non-blocking)
app.post('/api/debug/log-webhook', (req, res) => {
  const eventData = req.body;
  const receivedAt = new Date();

  // Store latest 100 events
  webhookLogs.unshift({ eventData, receivedAt });
  if (webhookLogs.length > 100) webhookLogs.pop();

  console.log('🔔 Webhook logged for debug:', JSON.stringify(eventData, null, 2));
  res.status(200).json({ success: true, message: 'Webhook logged' });
});

// Endpoint to view recent webhook logs with user info
app.get('/api/debug/webhook-debug', async (req, res) => {
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




// Add this route to your virtual account backend (server.js)
app.get('/api/payments/user-transactions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Assuming you have a Transaction model in your virtual account backend
    const transactions = await Transaction.find({ userId })
      .sort({ createdAt: -1 })
      .limit(100);
    
    res.json({
      success: true,
      transactions: transactions.map(tx => ({
        id: tx._id,
        reference: tx.reference,
        amount: tx.amount,
        type: tx.type,
        status: tx.status,
        description: tx.description,
        createdAt: tx.createdAt,
        metadata: tx.metadata
      }))
    });
  } catch (error) {
    console.error('Error fetching user transactions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch transactions: ' + error.message
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('🚨 Server error:', error);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'production' ? 'Something went wrong' : error.message
  });
});



const PORT = process.env.PORT || 3000;

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  console.log('✅ MongoDB connected successfully');
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🌐 CORS: All origins allowed`);
    console.log(`🔗 PayStack Proxy: http://localhost:${PORT}/api/payments/verify-paystack`);
    console.log(`🔗 Enhanced Proxy: http://localhost:${PORT}/api/payments/verify-paystack-enhanced`);
    console.log(`📁 Route files loaded: virtualAccount, webhooks, payments, wallet`);
  });
})
.catch(err => {
  console.error('❌ MongoDB connection failed:', err);
  process.exit(1);
});






