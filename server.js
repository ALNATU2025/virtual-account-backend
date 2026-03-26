// server.js - Updated with Cashwyre Integration
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();

// Cashwyre Configuration
const CASHWYRE_CONFIG = {
  baseURL: 'https://businessapi.cashwyre.com/api/v1.0',
  businessCode: 'C4B20260307000114',
  appId: 'C4B20260307000114',
  secretKey: 'secK_0cc3f3c57217673eb0581ba428b4d375d43d991d636303ac9c563ea8b6db2d873fb80586f448578090a1e7495b86f61423cb91121d9e957e6c9751933b3f2f9e',
  currency: 'SLE',
  country: 'SL'
};

// ==================== 1. RAW BODY MIDDLEWARE ====================
app.use((req, res, next) => {
  if (req.originalUrl.startsWith('/api/webhooks')) {
    let data = [];
    req.on('data', chunk => data.push(chunk));
    req.on('end', () => {
      req.rawBody = Buffer.concat(data);
      next();
    });
  } else {
    next();
  }
});

// ==================== 2. MOUNT WEBHOOK ROUTES ====================
const webhookRoutes = require('./routes/webhooks')(CASHWYRE_CONFIG);
app.use('/api/webhooks', webhookRoutes);

// ==================== 3. CORS & PARSERS ====================
app.use(cors({ origin: true, credentials: true }));
app.options('*', cors());

app.use((req, res, next) => {
  if (req.rawBody) {
    return next();
  }
  express.json({ limit: '10mb' })(req, res, next);
});

app.use(express.urlencoded({ extended: true }));

// ==================== 4. MODELS ====================

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  fullName: { type: String, required: true },
  phone: { type: String, required: true },
  walletBalance: { type: Number, default: 0 },
  commissionBalance: { type: Number, default: 0 },
  transactionPin: { type: String, default: null },
  transactionPinSet: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  role: { type: String, default: 'user' },
  cashwyreCustomerId: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const TransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['wallet_funding', 'transfer', 'debit', 'credit', 'commission'], required: true },
  amount: { type: Number, required: true },
  previousBalance: { type: Number, required: true },
  newBalance: { type: Number, required: true },
  reference: { type: String, required: true, unique: true },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  description: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed },
  serviceCharge: { type: Number, default: 0 },
  cashwyreReference: { type: String },
  completedAt: { type: Date }
});

const VirtualAccountSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  accountNumber: { type: String, required: true },
  accountName: { type: String, required: true },
  bankName: { type: String, required: true },
  bankCode: { type: String, required: true },
  currency: { type: String, default: 'SLE' },
  amount: { type: Number, required: true },
  totalPayable: { type: Number, required: true },
  fee: { type: Number, required: true },
  cashwyreRequestId: { type: String, required: true },
  expiresOn: { type: Date, required: true },
  expiresOnInMins: { type: Number, required: true },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);
const VirtualAccount = mongoose.model('VirtualAccount', VirtualAccountSchema);

// ==================== 5. HELPER FUNCTIONS ====================

const generateRequestId = () => {
  return `${Date.now()}${crypto.randomBytes(4).toString('hex')}`;
};

const calculateServiceCharge = (amount) => {
  if (amount >= 50000) {
    return 100;
  } else {
    return 50;
  }
};

// Cashwyre API Call Helper
const cashwyreApiCall = async (endpoint, data) => {
  try {
    const response = await axios.post(
      `${CASHWYRE_CONFIG.baseURL}${endpoint}`,
      data,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CASHWYRE_CONFIG.secretKey}`,
          'Accept': 'application/json'
        },
        timeout: 30000
      }
    );
    return response.data;
  } catch (error) {
    console.error('Cashwyre API Error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.message || error.message);
  }
};

// Create Dynamic Virtual Account via Cashwyre
const createDynamicAccount = async (userId, amount) => {
  const requestId = generateRequestId();
  
  const payload = {
    appId: CASHWYRE_CONFIG.appId,
    requestId: requestId,
    Amount: amount,
    businessCode: CASHWYRE_CONFIG.businessCode,
    currency: CASHWYRE_CONFIG.currency
  };
  
  const result = await cashwyreApiCall('/Account/createDynamicAccount', payload);
  
  if (result.success) {
    const virtualAccount = new VirtualAccount({
      userId,
      accountNumber: result.data.accountNumber,
      accountName: result.data.accountName,
      bankName: result.data.bankName,
      bankCode: result.data.bankCode,
      currency: result.data.currency,
      amount: result.data.amount,
      totalPayable: result.data.totalPayable,
      fee: result.data.fee,
      cashwyreRequestId: requestId,
      expiresOn: new Date(result.data.expiresOn),
      expiresOnInMins: result.data.expiresOnInMins,
      active: true
    });
    
    await virtualAccount.save();
    
    return {
      success: true,
      data: {
        accountNumber: result.data.accountNumber,
        accountName: result.data.accountName,
        bankName: result.data.bankName,
        bankCode: result.data.bankCode,
        expiresOn: result.data.expiresOn,
        expiresOnInMins: result.data.expiresOnInMins,
        amount: result.data.amount,
        totalPayable: result.data.totalPayable,
        fee: result.data.fee
      }
    };
  }
  
  return result;
};

// Initiate Payin (for mobile money)
const initiatePayin = async (userId, amount, bankCode, accountNumber, accountName) => {
  const requestId = generateRequestId();
  const transactionReference = generateRequestId();
  
  const payload = {
    appId: CASHWYRE_CONFIG.appId,
    requestId: requestId,
    amount: amount,
    currency: CASHWYRE_CONFIG.currency,
    businessCode: CASHWYRE_CONFIG.businessCode,
    bankCode: bankCode,
    country: CASHWYRE_CONFIG.country,
    accountNumber: accountNumber,
    accountName: accountName
  };
  
  const result = await cashwyreApiCall('/payin/initiatePayin', payload);
  
  if (result.success) {
    return {
      success: true,
      data: {
        reference: result.data.reference,
        transactionReference: transactionReference,
        accountNumber: result.data.accountNumber,
        accountName: result.data.accountName,
        bankCode: result.data.bankCode,
        bankName: result.data.bankName,
        depositAmount: result.data.depositAmount,
        feeAmount: result.data.feeAmount,
        canConfirmPayin: result.data.canConfirmPayin
      }
    };
  }
  
  return result;
};

// Update Wallet Balance
const updateWalletBalance = async (userId, amount, type, reference, description, metadata = {}) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const user = await User.findById(userId).session(session);
    if (!user) throw new Error('User not found');
    
    const previousBalance = user.walletBalance;
    let newBalance = previousBalance;
    let serviceCharge = 0;
    
    if (type === 'credit') {
      newBalance = previousBalance + amount;
    } else if (type === 'debit') {
      if (previousBalance < amount) throw new Error('Insufficient balance');
      newBalance = previousBalance - amount;
    }
    
    user.walletBalance = newBalance;
    user.updatedAt = new Date();
    await user.save({ session });
    
    if (type === 'credit' && amount >= 100) {
      serviceCharge = calculateServiceCharge(amount);
    }
    
    const transaction = new Transaction({
      userId,
      type: type === 'credit' ? 'wallet_funding' : 'debit',
      amount,
      previousBalance,
      newBalance,
      reference,
      status: 'completed',
      description,
      metadata,
      serviceCharge,
      completedAt: new Date()
    });
    
    await transaction.save({ session });
    
    if (serviceCharge > 0) {
      const serviceChargeTransaction = new Transaction({
        userId,
        type: 'commission',
        amount: serviceCharge,
        previousBalance: 0,
        newBalance: serviceCharge,
        reference: `${reference}_SERVICE_CHARGE`,
        status: 'completed',
        description: `Service charge for ${reference}`,
        metadata: { originalTransaction: reference, originalAmount: amount },
        serviceCharge: serviceCharge,
        completedAt: new Date()
      });
      await serviceChargeTransaction.save({ session });
    }
    
    await session.commitTransaction();
    
    return {
      success: true,
      newBalance,
      transaction: { id: transaction._id, reference, amount, serviceCharge }
    };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

// ==================== 6. API ENDPOINTS ====================

// Health check
app.get('/health', (req, res) => res.json({ status: 'OK', service: 'Cashwyre Wallet' }));

// Create dynamic virtual account
app.post('/api/virtual-accounts/create-dynamic', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    
    if (!userId) return res.status(400).json({ success: false, message: 'User ID required' });
    if (!amount || amount < 100) return res.status(400).json({ success: false, message: 'Minimum amount is 100 SLE' });
    
    const result = await createDynamicAccount(userId, amount);
    res.json(result);
  } catch (error) {
    console.error('Create dynamic account error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Initiate payin (mobile money)
app.post('/api/payments/initiate-payin', async (req, res) => {
  try {
    const { userId, amount, bankCode, accountNumber, accountName } = req.body;
    
    if (!userId || !amount) {
      return res.status(400).json({ success: false, message: 'User ID and amount required' });
    }
    
    const result = await initiatePayin(userId, amount, bankCode, accountNumber, accountName);
    res.json(result);
  } catch (error) {
    console.error('Initiate payin error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Confirm payin
app.post('/api/payments/confirm-payin', async (req, res) => {
  try {
    const { requestId, transactionReference, reference } = req.body;
    
    if (!requestId || !transactionReference || !reference) {
      return res.status(400).json({ success: false, message: 'Missing required parameters' });
    }
    
    const payload = {
      appId: CASHWYRE_CONFIG.appId,
      requestId: requestId,
      transactionReference: transactionReference,
      reference: reference
    };
    
    const result = await cashwyreApiCall('/payin/confirmPayin', payload);
    res.json(result);
  } catch (error) {
    console.error('Confirm payin error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get payin status
app.post('/api/payments/payin-status', async (req, res) => {
  try {
    const { requestId, transactionReference } = req.body;
    
    if (!requestId || !transactionReference) {
      return res.status(400).json({ success: false, message: 'Missing required parameters' });
    }
    
    const payload = {
      appId: CASHWYRE_CONFIG.appId,
      requestId: requestId,
      transactionReference: transactionReference
    };
    
    const result = await cashwyreApiCall('/payin/payinStatus', payload);
    res.json(result);
  } catch (error) {
    console.error('Payin status error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get user balance
app.get('/api/wallet/balance/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, walletBalance: user.walletBalance, commissionBalance: user.commissionBalance });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get virtual account details
app.get('/api/virtual-accounts/:userId', async (req, res) => {
  try {
    const virtualAccount = await VirtualAccount.findOne({ 
      userId: req.params.userId, 
      active: true,
      expiresOn: { $gt: new Date() }
    }).sort({ createdAt: -1 });
    
    if (!virtualAccount) {
      return res.json({ success: false, message: 'No active virtual account', hasAccount: false });
    }
    
    res.json({
      success: true,
      accountNumber: virtualAccount.accountNumber,
      accountName: virtualAccount.accountName,
      bankName: virtualAccount.bankName,
      bankCode: virtualAccount.bankCode,
      expiresOn: virtualAccount.expiresOn,
      active: virtualAccount.active
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get user transactions
app.get('/api/transactions/:userId', async (req, res) => {
  try {
    const { limit = 50, skip = 0 } = req.query;
    const transactions = await Transaction.find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));
    
    const total = await Transaction.countDocuments({ userId: req.params.userId });
    
    res.json({ success: true, transactions, pagination: { total, limit: parseInt(limit), skip: parseInt(skip) } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Admin dashboard - Get all service charges
app.get('/api/admin/service-charges', async (req, res) => {
  try {
    const serviceCharges = await Transaction.find({ serviceCharge: { $gt: 0 } })
      .sort({ createdAt: -1 })
      .populate('userId', 'fullName email');
    
    const totalServiceCharges = serviceCharges.reduce((sum, t) => sum + (t.serviceCharge || 0), 0);
    const totalTransactions = await Transaction.countDocuments();
    
    const dailyCharges = await Transaction.aggregate([
      { $match: { serviceCharge: { $gt: 0 } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          total: { $sum: '$serviceCharge' },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: -1 } }
    ]);
    
    res.json({
      success: true,
      data: {
        totalServiceCharges,
        totalTransactions,
        serviceCharges,
        dailyCharges,
        summary: {
          today: serviceCharges.filter(t => 
            new Date(t.createdAt).toDateString() === new Date().toDateString()
          ).reduce((sum, t) => sum + (t.serviceCharge || 0), 0)
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Transfer to user
app.post('/api/transfer', async (req, res) => {
  try {
    const { senderId, receiverEmail, amount, description, transactionPin } = req.body;
    
    if (!senderId || !receiverEmail || !amount) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    const sender = await User.findById(senderId);
    if (!sender) return res.status(404).json({ success: false, message: 'Sender not found' });
    
    if (transactionPin) {
      if (!sender.transactionPinSet || sender.transactionPin !== transactionPin) {
        return res.status(401).json({ success: false, message: 'Invalid transaction PIN' });
      }
    }
    
    const receiver = await User.findOne({ email: receiverEmail });
    if (!receiver) return res.status(404).json({ success: false, message: 'Receiver not found' });
    
    if (sender._id.toString() === receiver._id.toString()) {
      return res.status(400).json({ success: false, message: 'Cannot transfer to yourself' });
    }
    
    if (sender.walletBalance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }
    
    const reference = `TRF_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
      const senderPrevBalance = sender.walletBalance;
      sender.walletBalance -= amount;
      await sender.save({ session });
      
      const receiverPrevBalance = receiver.walletBalance;
      receiver.walletBalance += amount;
      await receiver.save({ session });
      
      await new Transaction({
        userId: sender._id,
        type: 'transfer',
        amount,
        previousBalance: senderPrevBalance,
        newBalance: sender.walletBalance,
        reference,
        status: 'completed',
        description: description || `Transfer to ${receiver.email}`,
        metadata: { receiverId: receiver._id, receiverEmail: receiver.email },
        completedAt: new Date()
      }).save({ session });
      
      await new Transaction({
        userId: receiver._id,
        type: 'credit',
        amount,
        previousBalance: receiverPrevBalance,
        newBalance: receiver.walletBalance,
        reference: `${reference}_RECEIVER`,
        status: 'completed',
        description: description || `Transfer from ${sender.email}`,
        metadata: { senderId: sender._id, senderEmail: sender.email },
        completedAt: new Date()
      }).save({ session });
      
      await session.commitTransaction();
      
      res.json({
        success: true,
        amount,
        receiverName: receiver.fullName,
        receiverEmail: receiver.email,
        newBalance: sender.walletBalance,
        message: 'Transfer completed successfully'
      });
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error('Transfer error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Verify transaction PIN
app.post('/api/users/verify-transaction-pin', async (req, res) => {
  try {
    const { userId, transactionPin } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    
    if (!user.transactionPinSet || user.transactionPin !== transactionPin) {
      return res.status(401).json({ success: false, message: 'Invalid transaction PIN' });
    }
    
    res.json({ success: true, message: 'PIN verified' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Set transaction PIN
app.post('/api/users/set-transaction-pin', async (req, res) => {
  try {
    const { userId, transactionPin } = req.body;
    
    if (!/^\d{6}$/.test(transactionPin)) {
      return res.status(400).json({ success: false, message: 'PIN must be 6 digits' });
    }
    
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    
    user.transactionPin = transactionPin;
    user.transactionPinSet = true;
    await user.save();
    
    res.json({ success: true, message: 'Transaction PIN set successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Create user
app.post('/api/users/create', async (req, res) => {
  try {
    const { email, fullName, phone } = req.body;
    
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.json({ success: true, userId: existingUser._id, user: existingUser });
    }
    
    const user = new User({ email, fullName, phone });
    await user.save();
    
    res.json({ success: true, userId: user._id, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get current user (mock - in real app use JWT)
app.get('/api/users/current', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const user = await User.findById(token);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    
    res.json({
      success: true,
      data: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        walletBalance: user.walletBalance,
        commissionBalance: user.commissionBalance,
        transactionPinSet: user.transactionPinSet,
        isActive: user.isActive
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== 7. WEBHOOK ROUTES ====================
// webhooks.js file content
const webhookRoutes = (config) => {
  const router = express.Router();
  
  // Cashwyre webhook for fiat deposits
  router.post('/cashwyre', async (req, res) => {
    try {
      console.log('Cashwyre webhook received:', req.rawBody?.toString() || JSON.stringify(req.body));
      
      let webhookData;
      if (req.rawBody) {
        webhookData = JSON.parse(req.rawBody.toString());
      } else {
        webhookData = req.body;
      }
      
      const { eventType, eventData } = webhookData;
      
      if (eventType === 'fiat_deposit.success') {
        const { AccountNumber, AmountSettled, Code, RequestId, Narration, BankName } = eventData;
        
        const virtualAccount = await VirtualAccount.findOne({ accountNumber: AccountNumber });
        if (virtualAccount) {
          const amount = parseFloat(AmountSettled);
          const reference = `CASHWYRE_${Code || RequestId || Date.now()}`;
          
          const existingTx = await Transaction.findOne({ reference });
          if (!existingTx) {
            await updateWalletBalance(
              virtualAccount.userId,
              amount,
              'credit',
              reference,
              Narration || `Deposit from ${BankName} - ${AccountNumber}`,
              { source: 'cashwyre_webhook', paymentMethod: 'bank_transfer' }
            );
            console.log(`✅ Processed Cashwyre deposit: ${amount} SLE for user ${virtualAccount.userId}`);
          }
        }
      }
      
      res.status(200).json({ success: true, message: 'Webhook received' });
    } catch (error) {
      console.error('Webhook error:', error.message);
      res.status(500).json({ success: false, message: error.message });
    }
  });
  
  return router;
};

module.exports = webhookRoutes;

// ==================== 8. START SERVER ====================

const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/cashwyre_wallet')
  .then(() => {
    console.log('MongoDB connected');
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Cashwyre Business Code: ${CASHWYRE_CONFIG.businessCode}`);
      console.log(`Currency: ${CASHWYRE_CONFIG.currency}`);
      console.log(`Webhook URL: http://localhost:${PORT}/api/webhooks/cashwyre`);
    });
  })
  .catch(err => console.error('MongoDB connection error:', err));
