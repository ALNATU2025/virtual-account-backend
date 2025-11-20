const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { body, validationResult } = require('express-validator');
require('dotenv').config();

const app = express();

// ==================== SYNC WITH MAIN BACKEND ====================
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'https://vtpass-backend.onrender.com';

// Fixed & working sync function
async function syncVirtualAccountTransferWithMainBackend(userId, amountInNaira, reference) {
  if (!MAIN_BACKEND_URL) {
    console.error('MAIN_BACKEND_URL not set');
    return;
  }

  // ALWAYS send amount in KOBO (PayStack standard)
  const payload = {
    userId: userId.toString(),
    amount: Math.round(amountInNaira * 100), // ← KOBO
    reference,
    description: `Virtual account deposit - ${reference}`,
    source: 'virtual_account_webhook'
  };

  for (let i = 0; i < 3; i++) {
    try {
      console.log(`Sync attempt ${i + 1} → ${MAIN_BACKEND_URL}/api/wallet/top-up`, payload);

      const res = await fetch(`${MAIN_BACKEND_URL}/api/wallet/top-up`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: 15000
      });

      const data = await res.json();
      if (res.ok && (data.success || data.alreadyProcessed)) {
        console.log('Sync SUCCESS:', data.newBalance || 'already processed');
        return;
      }
    } catch (e) {
      console.error(`Sync attempt ${i + 1} failed:`, e.message);
      if (i === 2) throw e;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

// ==================== MIDDLEWARE ====================
app.use(cors({
  origin: true,
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
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ==================== IMPORT MODELS ====================
const Transaction = require('./models/Transaction');
const User = require('./models/User');

// ==================== IMPORT ROUTES ====================
const virtualAccountRoutes = require('./routes/virtualAccount');
const virtualAccountSyncRoutes = require('./routes/virtualAccountSyncRoutes'); // NEW
const webhookRoutes = require('./routes/webhooks');
const paymentRoutes = require('./routes/payments');
const walletRoutes = require('./routes/wallet');

// ==================== MOUNT ROUTES ====================
app.use('/api/virtual-accounts', virtualAccountRoutes);
app.use('/', virtualAccountSyncRoutes); // Mounted at root
app.use('/api/webhooks', webhookRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/wallet', walletRoutes);

console.log('✅ All routes mounted successfully');

// ==================== PAYSTACK CORS PROXY ====================
app.post('/api/payments/verify-paystack', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ success: false, message: 'Reference is required' });

    console.log('🔍 CORS Proxy: Verifying PayStack transaction:', reference);

    const paystackResponse = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await paystackResponse.json();
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
      res.json({ success: false, message: data.message || 'Payment verification failed', status: data.data?.status || 'unknown' });
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

// ==================== ENHANCED PAYSTACK VERIFICATION ====================
app.post('/api/payments/verify-paystack-enhanced', [
  body('reference').notEmpty().withMessage('Reference is required'),
  body('userId').optional().isMongoId().withMessage('Valid user ID required')
], async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { reference, userId } = req.body;

    const existingTransaction = await Transaction.findOne({ reference, status: 'success' }).session(session);
    if (existingTransaction) {
      await session.abortTransaction();
      const currentBalance = userId ? (await User.findById(userId))?.walletBalance || 0 : 0;
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

    const paystackResponse = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    });
    const data = await paystackResponse.json();

    if (data.status && data.data && data.data.status === 'success') {
      const amount = data.data.amount / 100;
      if (userId) {
        const user = await User.findById(userId).session(session);
        if (!user) { await session.abortTransaction(); return res.status(404).json({ success: false, message: 'User not found' }); }

        const balanceBefore = user.walletBalance;
        user.walletBalance += amount;
        const balanceAfter = user.walletBalance;
        await user.save({ session });

        const transaction = await Transaction.create([{
          userId,
          type: 'wallet_funding',
          amount,
          status: 'success',
          reference,
          gateway: 'paystack',
          description: `Wallet funding via PayStack - Ref: ${reference}`,
          metadata: {
            source: 'paystack_proxy',
            verifiedAt: new Date(),
            customerEmail: data.data.customer?.email,
            balanceBefore,
            balanceAfter,
            balanceUpdated: true,
            paystackData: { paidAt: data.data.paid_at, channel: data.data.channel, currency: data.data.currency }
          }
        }], { session });

        await session.commitTransaction();

        return res.json({
          success: true,
          status: data.data.status,
          amount,
          reference: data.data.reference,
          paidAt: data.data.paid_at,
          newBalance: balanceAfter,
          message: 'Payment verified successfully with database protection',
          source: 'enhanced_cors_proxy',
          transactionId: transaction[0]._id
        });
      } else {
        await session.commitTransaction();
        return res.json({
          success: true,
          status: data.data.status,
          amount,
          reference: data.data.reference,
          paidAt: data.data.paid_at,
          message: 'Payment verified successfully (no balance update - user ID required)',
          source: 'cors_proxy_backend',
          needsUserId: true
        });
      }
    } else {
      await session.abortTransaction();
      return res.json({ success: false, message: data.message || 'Payment verification failed', status: data.data?.status || 'unknown' });
    }

  } catch (error) {
    await session.abortTransaction();
    if (error.code === 11000 || error.message.includes('duplicate key')) {
      return res.json({ success: false, message: 'Transaction was already processed', alreadyProcessed: true, databaseConstraint: true });
    }
    return res.status(500).json({ success: false, message: 'Enhanced verification service temporarily unavailable', error: process.env.NODE_ENV === 'production' ? null : error.message });
  } finally {
    session.endSession();
  }
});

// ==================== VIRTUAL ACCOUNT WEBHOOK ====================
app.post('/api/webhooks/virtual-account', async (req, res) => {
  console.log('🔔 Virtual Account Webhook Received:', JSON.stringify(req.body, null, 2));
  res.status(200).json({ success: true, message: 'Webhook received' });

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { event, data } = req.body;
    if (event === 'transfer.success') {
      const { reference, amount, recipient, sender } = data;
      const virtualAccountNumber = recipient?.account_number;
      if (!virtualAccountNumber) { await session.abortTransaction(); return; }

      const user = await User.findOne({ virtualAccountNumber }).session(session);
      if (!user) { await session.abortTransaction(); return; }

      const existingTransaction = await Transaction.findOne({ reference }).session(session);
      if (existingTransaction && existingTransaction.status === 'success') { await session.abortTransaction(); return; }

      const amountInNaira = amount / 100;
      const balanceBefore = user.walletBalance;
      user.walletBalance += amountInNaira;
      const balanceAfter = user.walletBalance;
      await user.save({ session });

      const transactionData = {
        userId: user._id.toString(),
        type: 'virtual_account_deposit',
        amount: amountInNaira,
        status: 'success',
        reference,
        gateway: 'paystack_virtual_account',
        description: `Virtual account deposit - ${virtualAccountNumber}`,
        balanceBefore,
        balanceAfter,
        metadata: {
          source: 'virtual_account_webhook',
          verifiedAt: new Date(),
          virtualAccountNumber,
          balanceUpdated: true,
          sender: sender?.name || 'Unknown',
          bank: recipient?.bank?.name,
          webhookData: data
        }
      };

      await Transaction.create([transactionData], { session });
      await session.commitTransaction();

      console.log('✅ Virtual Account Transfer Processed:', { reference, amount: amountInNaira, user: user.email, newBalance: balanceAfter });

      // Sync with main backend (non-blocking)
      try { await syncVirtualAccountTransferWithMainBackend(user._id, amountInNaira, reference); } 
      catch (syncError) { console.error('⚠️ Sync failed but balance updated:', syncError.message); }
    } else {
      await session.commitTransaction();
    }
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Virtual Account Webhook Error:', error);
  } finally { session.endSession(); }
});

// ==================== DEBUG WEBHOOK LOGGING ====================
let webhookLogs = [];
app.post('/api/debug/log-webhook', (req, res) => {
  const eventData = req.body;
  const receivedAt = new Date();
  webhookLogs.unshift({ eventData, receivedAt });
  if (webhookLogs.length > 100) webhookLogs.pop();
  console.log('🔔 Webhook logged for debug:', JSON.stringify(eventData, null, 2));
  res.status(200).json({ success: true, message: 'Webhook logged' });
});
app.get('/api/debug/webhook-debug', async (req, res) => {
  try {
    const logsWithUser = await Promise.all(webhookLogs.map(async log => {
      let virtualAccountNumber = log.eventData.data?.recipient?.account_number;
      let user = virtualAccountNumber ? await User.findOne({ virtualAccountNumber }) : null;
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
    }));
    res.json({ success: true, logs: logsWithUser });
  } catch (error) {
    console.error('❌ Failed to get webhook debug logs:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch webhook debug logs', error: process.env.NODE_ENV === 'production' ? null : error.message });
  }
});

// ==================== USER TRANSACTIONS ====================
app.get('/api/payments/user-transactions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const transactions = await Transaction.find({ userId }).sort({ createdAt: -1 }).limit(100);
    res.json({ success: true, transactions });
  } catch (error) {
    console.error('Error fetching user transactions:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch transactions: ' + error.message });
  }
});

// ==================== CHECK TRANSACTION REFERENCE ====================
app.get('/api/payments/check-reference/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    const { userId } = req.query;
    const transaction = await Transaction.findOne({ reference });
    if (!transaction) return res.json({ exists: false, message: 'Transaction reference not found' });

    const userOwnsTransaction = userId ? transaction.userId.toString() === userId : true;
    res.json({ exists: true, userOwnsTransaction, alreadyProcessed: transaction.status === 'success', transaction });
  } catch (error) {
    console.error('Error checking transaction reference:', error);
    res.status(500).json({ success: false, message: 'Failed to check transaction reference' });
  }
});

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
  res.json({ success: true, message: 'Virtual Account Backend is running', timestamp: new Date(), environment: process.env.NODE_ENV || 'development', database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', cors: 'Enabled - All origins allowed' });
});

// ==================== ROOT ====================
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Virtual Account Backend is running successfully',
    version: '1.0.0',
    cors: 'Enabled - All origins allowed',
    endpoints: {
      simple_verification: '/api/payments/verify-paystack',
      enhanced_verification: '/api/payments/verify-paystack-enhanced',
      check_reference: '/api/payments/check-reference/:reference',
      health: '/health'
    }
  });
});

// ==================== 404 & ERROR HANDLER ====================
app.use('*', (req, res) => res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` }));
app.use((error, req, res, next) => { console.error('🚨 Server error:', error); res.status(500).json({ success: false, message: 'Internal server error', error: process.env.NODE_ENV === 'production' ? 'Something went wrong' : error.message }); });

// ==================== SERVER & DATABASE ====================
const PORT = process.env.PORT || 3000;
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    console.log('✅ MongoDB connected successfully');
    app.listen(PORT, () => { console.log(`🚀 Server running on port ${PORT}`); });
  })
  .catch(err => { console.error('❌ MongoDB connection failed:', err); process.exit(1); });

