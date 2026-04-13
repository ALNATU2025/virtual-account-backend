// server.js - COMPLETE WORKING VERSION for NGN currency
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();

// Add this after the other constants
const forceRefreshCooldown = new Map(); // Track last refresh time per user
const FORCE_REFRESH_DELAY = 5000; // 5 seconds cooldown

// Cashwyre Configuration for NGN
const CASHWYRE_CONFIG = {
  baseURL: 'https://businessapi.cashwyre.com/api/v1.0',
  businessCode: 'C4B20260307000114',
  appId: 'C4B20260307000114',
  secretKey: 'secK_0cc3f3c57217673eb0581ba428b4d375d43d991d636303ac9c563ea8b6db2d873fb80586f448578090a1e7495b86f61423cb91121d9e957e6c9751933b3f2f9e',
  currency: 'NGN',
  country: 'NG'
};

// ==================== RAW BODY MIDDLEWARE ====================
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    if (req.originalUrl.startsWith('/api/webhooks')) {
      req.rawBody = buf.toString();
    }
  }
}));

app.use(express.urlencoded({ extended: true }));

// ==================== CORS ====================
app.use(cors({ origin: true, credentials: true }));
app.options('*', cors());

// ==================== JSON PARSER ====================


// ==================== MONGODB MODELS ====================
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
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'completed' },
  description: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed },
  serviceCharge: { type: Number, default: 0 },
  cashwyreReference: { type: String },
  completedAt: { type: Date, default: Date.now }
});

// Find this schema in your server.js (around line 80-100)
const VirtualAccountSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  accountNumber: { type: String, required: true },
  accountName: { type: String, required: true },
  bankName: { type: String, required: true },
  bankCode: { type: String, required: true },
  currency: { type: String, default: 'NGN' },
  amount: { type: Number, required: true },
  totalPayable: { type: Number, required: true },
  fee: { type: Number, required: true },
  cashwyreRequestId: { type: String, required: true, unique: true },
  cashwyreReference: { type: String },
  expiresOn: { type: Date, required: true },  // Keep required true, but we now provide it
  expiresOnInMins: { type: Number, required: true },
  active: { type: Boolean, default: true },
  processedAt: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

// Indexes
VirtualAccountSchema.index({ userId: 1, createdAt: -1 });
VirtualAccountSchema.index({ accountNumber: 1 }, { unique: true });

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);
const VirtualAccount = mongoose.model('VirtualAccount', VirtualAccountSchema);

// Unmatched Webhook Schema for debugging
const UnmatchedWebhookSchema = new mongoose.Schema({
  reference: { type: String },
  payload: { type: mongoose.Schema.Types.Mixed },
  receivedAt: { type: Date, default: Date.now }
});
const UnmatchedWebhook = mongoose.model('UnmatchedWebhook', UnmatchedWebhookSchema);

// ==================== HELPER FUNCTIONS ====================
const generateRequestId = () => {
  return `${Date.now()}${crypto.randomBytes(4).toString('hex')}`;
};

const calculateServiceCharge = (amount) => {
  // YOUR APP'S SERVICE CHARGE (not including payment provider fees)
  // - ₦100 for amounts ₦50,000 and above
  // - ₦50 for amounts below ₦50,000
  if (amount >= 50000) {
    return 100;
  } else {
    return 50;
  }
};


// Cashwyre API Call
const cashwyreApiCall = async (endpoint, data) => {
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
};

// Create Dynamic Virtual Account
// Create Dynamic Virtual Account - Frontend shows fixed fee, backend calculates adjustment
const createDynamicAccount = async (userId, amount) => {
  const requestId = generateRequestId();
  
  // FRONTEND DISPLAY FEE (what user sees)
  let frontendDisplayFee = 0;
  if (amount >= 50000) {
    frontendDisplayFee = 100;  // User sees ₦100 for amounts ₦50,000+
  } else {
    frontendDisplayFee = 50;   // User sees ₦50 for amounts below ₦50,000
  }
  
  // Calculate what user should pay TOTAL (what they see in frontend)
  const userSeesTotalPayable = amount + frontendDisplayFee;
  
  // Calculate expiresOn FIRST - before using it
  const expiresOn = new Date();
  expiresOn.setHours(expiresOn.getHours() + 1); // 1 hour from now
  const expiresOnInMins = 60;
  
  // Prepare payload for Cashwyre - send the ORIGINAL amount
  const payload = {
    appId: CASHWYRE_CONFIG.appId,
    requestId: requestId,
    amount: amount,  // Send original amount (e.g., 100)
    currency: CASHWYRE_CONFIG.currency,
    businessCode: CASHWYRE_CONFIG.businessCode,
    country: CASHWYRE_CONFIG.country,
    feeType: "sender"
  };
  
  try {
    console.log(`💰 Calling Cashwyre /payin/initiatePayin for amount: ₦${amount}`);
    console.log(`   feeType: sender (customer pays fee)`);
    
    const result = await cashwyreApiCall('/payin/initiatePayin', payload);
    
    if (result.success) {
      // Cashwyre returns depositAmount (includes their fee)
      const cashwyreDepositAmount = result.data.depositAmount || amount;
      const cashwyreFee = result.data.feeAmount || 0;
      
      // BACKEND CALCULATES THE ACTUAL ADJUSTMENT
      // User should pay total = amount + frontendDisplayFee (e.g., ₦150)
      // Cashwyre says user pays = cashwyreDepositAmount (e.g., ₦101.50)
      // So your ACTUAL platform fee = userSeesTotalPayable - cashwyreDepositAmount
      const actualPlatformFee = userSeesTotalPayable - cashwyreDepositAmount;
      
      // The user pays this amount (same as what they see in frontend)
      const userTotalPayable = userSeesTotalPayable;
      
      console.log(`💰 CASHWYRE PAYIN RESPONSE:`);
      console.log(`   Account Number: ${result.data.accountNumber}`);
      console.log(`   Account Name: ${result.data.accountName}`);
      console.log(`   Bank Name: ${result.data.bankName}`);
      console.log(`   Cashwyre Fee: ₦${cashwyreFee}`);
      console.log(`   Cashwyre Deposit Amount: ₦${cashwyreDepositAmount}`);
      
      console.log(`💰 BACKEND ADJUSTMENT CALCULATION:`);
      console.log(`   User wants to fund: ₦${amount}`);
      console.log(`   Frontend shows fee: ₦${frontendDisplayFee}`);
      console.log(`   User sees total: ₦${userSeesTotalPayable}`);
      console.log(`   Cashwyre says user pays: ₦${cashwyreDepositAmount}`);
      console.log(`   Backend adjustment: ₦${actualPlatformFee.toFixed(2)}`);
      console.log(`   TOTAL USER PAYS: ₦${userTotalPayable}`);
      console.log(`   User receives: ₦${amount}`);
      console.log(`   Expires On: ${expiresOn.toISOString()}`);
      
      // Create pending transaction in MongoDB
      const user = await User.findById(userId);
      if (user) {
        const balanceBefore = user.walletBalance;
        
        const existingPending = await Transaction.findOne({ 
          reference: requestId,
          status: 'pending'
        });
        
        if (!existingPending) {
          const pendingTransaction = new Transaction({
            userId: userId,
            type: 'wallet_funding',
            amount: amount,
            previousBalance: balanceBefore,
            newBalance: balanceBefore,
            reference: requestId,
            cashwyreReference: result.data.reference,
            status: 'pending',
            description: `Wallet funding - ₦${amount}`,
            metadata: {
              source: 'cashwyre_payin',
              accountNumber: result.data.accountNumber,
              accountName: result.data.accountName,
              bankName: result.data.bankName,
              bankCode: result.data.bankCode,
              cashwyreDepositAmount: cashwyreDepositAmount,
              cashwyreFee: cashwyreFee,
              frontendDisplayFee: frontendDisplayFee,
              actualPlatformFee: actualPlatformFee,
              totalPayable: userTotalPayable,
              amountToCredit: amount,
              transactionReference: result.data.transactionReference,
              feeType: result.data.feeType,
              canConfirmPayin: result.data.canConfirmPayin,
              requestId: requestId,
              expiresOn: expiresOn,
              expiresOnInMins: expiresOnInMins
            },
            completedAt: null
          });
          
          await pendingTransaction.save();
          console.log(`✅ Pending transaction saved to MongoDB`);
        }
      }
      
      // Store virtual account info in MongoDB
      const virtualAccount = new VirtualAccount({
        userId,
        accountNumber: result.data.accountNumber,
        accountName: result.data.accountName,
        bankName: result.data.bankName,
        bankCode: result.data.bankCode,
        currency: result.data.currency || 'NGN',
        amount: amount,
        totalPayable: userTotalPayable,
        fee: frontendDisplayFee,  // Store what user sees
        cashwyreRequestId: requestId,
        cashwyreReference: result.data.reference,
        expiresOn: expiresOn,
        expiresOnInMins: expiresOnInMins,
        active: true
      });
      
      await virtualAccount.save();
      
      console.log(`✅ Payin initiated successfully`);
      console.log(`   Account: ${result.data.accountNumber}`);
      console.log(`   Bank: ${result.data.bankName}`);
      console.log(`   Reference: ${result.data.reference}`);
      console.log(`   User pays: ₦${userTotalPayable}`);
      console.log(`   User receives: ₦${amount}`);
      console.log(`   Frontend shows fee: ₦${frontendDisplayFee}`);
      console.log(`   Actual backend fee: ₦${actualPlatformFee.toFixed(2)}`);
      console.log(`   Expires: ${expiresOn.toISOString()}`);
      
      return {
        success: true,
        data: {
          accountNumber: result.data.accountNumber,
          accountName: result.data.accountName,
          bankName: result.data.bankName,
          bankCode: result.data.bankCode,
          expiresOn: expiresOn.toISOString(),
          expiresOnInMins: expiresOnInMins,
          amount: amount,
          totalPayable: userTotalPayable,
          fee: frontendDisplayFee,
          reference: result.data.reference,
          transactionReference: result.data.transactionReference,
          feeType: result.data.feeType,
          requestId: requestId
        }
      };
    }
    return result;
  } catch (error) {
    console.error('Error:', error.message);
    throw error;
  }
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
      const serviceChargeTx = new Transaction({
        userId,
        type: 'commission',
        amount: serviceCharge,
        previousBalance: 0,
        newBalance: serviceCharge,
        reference: `${reference}_SERVICE_CHARGE`,
        status: 'completed',
        description: `Service charge for ₦${amount} deposit`,
        metadata: { originalTransaction: reference, originalAmount: amount },
        serviceCharge: serviceCharge,
        completedAt: new Date()
      });
      await serviceChargeTx.save({ session });
    }
    
    await session.commitTransaction();
    
    return {
      success: true,
      newBalance,
      serviceCharge,
      transaction: { id: transaction._id, reference, amount }
    };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

// ==================== API ENDPOINTS ====================

// Health check
app.get('/health', (req, res) => res.json({ status: 'OK', service: 'Cashwyre Wallet' }));

// Create dynamic virtual account
app.post('/api/virtual-accounts/create-dynamic', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID required' });
    }
    
    if (!amount || amount < 100) {
      return res.status(400).json({ success: false, message: 'Minimum amount is ₦100' });
    }
    
    const result = await createDynamicAccount(userId, amount);
    res.json(result);
  } catch (error) {
    console.error('Create account error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});



// Unmatched webhook endpoint
app.post('/api/webhooks/unmatched', async (req, res) => {
  console.log('📦 Unmatched webhook received:', JSON.stringify(req.body, null, 2));
  
  try {
    const unmatched = new UnmatchedWebhook({
      reference: req.body.cashwyreCode,
      payload: req.body,
      receivedAt: new Date()
    });
    await unmatched.save();
    
    res.json({ success: true, message: 'Unmatched webhook stored' });
  } catch (error) {
    console.error('Error storing unmatched webhook:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});



// Get the most recent active virtual account for a user
app.get('/api/virtual-accounts/latest/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const virtualAccount = await VirtualAccount.findOne({ 
      userId: userId,
      expiresOn: { $gt: new Date() }
    }).sort({ createdAt: -1 });
    
    if (!virtualAccount) {
      return res.json({ success: false, message: 'No active virtual account found', hasAccount: false });
    }
    
    res.json({
      success: true,
      accountNumber: virtualAccount.accountNumber,
      accountName: virtualAccount.accountName,
      bankName: virtualAccount.bankName,
      bankCode: virtualAccount.bankCode,
      expiresOn: virtualAccount.expiresOn,
      active: virtualAccount.active,
      amount: virtualAccount.amount,
      totalPayable: virtualAccount.totalPayable,
      fee: virtualAccount.fee
    });
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




// Check transaction status in MongoDB - ADD THIS
app.get('/api/transactions/check-status', async (req, res) => {
  try {
    const { reference } = req.query;
    
    if (!reference) {
      return res.json({ success: false, message: 'Reference required' });
    }
    
    console.log('🔍 Checking transaction status for reference:', reference);
    
    // Search in transactions collection
    const transaction = await Transaction.findOne({ 
      $or: [
        { reference: reference },
        { cashwyreReference: reference }
      ]
    });
    
    if (transaction) {
      console.log('✅ Found transaction in MongoDB. Status:', transaction.status);
      return res.json({
        success: true,
        status: transaction.status,
        amount: transaction.amount,
        completedAt: transaction.completedAt
      });
    }
    
    // Also check virtual accounts
    const virtualAccount = await VirtualAccount.findOne({
      $or: [
        { cashwyreRequestId: reference },
        { cashwyreReference: reference }
      ]
    });
    
    if (virtualAccount && !virtualAccount.active) {
      console.log('✅ Found virtual account (processed). Amount:', virtualAccount.amount);
      return res.json({
        success: true,
        status: 'completed',
        amount: virtualAccount.amount
      });
    }
    
    console.log('⏳ Transaction not found in MongoDB yet');
    res.json({ success: false, status: 'pending' });
    
  } catch (error) {
    console.error('Check status error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});





// Add this to your server.js - Get Cashwyre transactions for a user
app.get('/api/transactions/cashwyre/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 100, skip = 0 } = req.query;
    
    // Get wallet funding transactions from Cashwyre
    const transactions = await Transaction.find({ 
      userId: userId,
      type: 'wallet_funding',
      'metadata.source': 'cashwyre_webhook_sync'
    })
    .sort({ createdAt: -1 })
    .limit(parseInt(limit))
    .skip(parseInt(skip));
    
    const total = await Transaction.countDocuments({ 
      userId: userId,
      type: 'wallet_funding',
      'metadata.source': 'cashwyre_webhook_sync'
    });
    
    res.json({
      success: true,
      transactions: transactions,
      total: total,
      source: 'cashwyre'
    });
  } catch (error) {
    console.error('Error fetching Cashwyre transactions:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get all transactions (combined from both sources)
app.get('/api/transactions/all/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 100, skip = 0 } = req.query;
    
    // Get all transactions (all types, all sources)
    const transactions = await Transaction.find({ userId: userId })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));
    
    const total = await Transaction.countDocuments({ userId: userId });
    
    res.json({
      success: true,
      transactions: transactions,
      total: total,
      pagination: { limit: parseInt(limit), skip: parseInt(skip) }
    });
  } catch (error) {
    console.error('Error fetching all transactions:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});



// Get transactions
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


// Partial payment webhook endpoint
app.post('/api/webhooks/partial-payment', async (req, res) => {
  console.log('⚠️ Partial payment webhook received:', JSON.stringify(req.body, null, 2));
  
  try {
    const { userId, amount, reference, accountNumber, requiredAmount } = req.body;
    
    // Create a partial payment record
    const partialPayment = new Transaction({
      userId,
      type: 'partial_payment',
      amount,
      previousBalance: 0,
      newBalance: 0,
      reference: `PARTIAL_${reference}`,
      status: 'failed',
      description: `Partial payment of ₦${amount} detected. Required amount was ₦${requiredAmount}. Contact support.`,
      metadata: {
        source: 'cashwyre_webhook',
        accountNumber: accountNumber,
        requiredAmount: requiredAmount,
        isPartial: true
      },
      completedAt: new Date()
    });
    
    await partialPayment.save();
    
    res.json({ success: true, message: 'Partial payment recorded' });
  } catch (error) {
    console.error('Error processing partial payment:', error.message);
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
    
    let user = await User.findOne({ email });
    if (user) {
      return res.json({ success: true, userId: user._id, user });
    }
    
    user = new User({ email, fullName, phone });
    await user.save();
    
    res.json({ success: true, userId: user._id, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get current user
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

// ==================== CHECK PAYIN STATUS ENDPOINT ====================
app.post('/api/payin/check-status', async (req, res) => {
  try {
    const { reference, transactionReference } = req.body;
    
    const searchRef = reference || transactionReference;
    console.log('🔍 Checking payin status for:', searchRef);
    
    // Search in Transaction table by multiple fields
    const transaction = await Transaction.findOne({ 
      $or: [
        { reference: searchRef },
        { cashwyreReference: searchRef },
        { 'metadata.cashwyreCode': searchRef },
        { 'metadata.cashwyreRequestId': searchRef },
        { 'metadata.requestId': searchRef }
      ]
    });
    
    if (transaction && transaction.status === 'completed') {
      console.log('✅ Transaction found in local DB - COMPLETED');
      return res.json({
        success: true,
        status: 'completed',
        amount: transaction.amount,
        data: {
          status: 'completed',
          depositAmount: transaction.amount,
          transactionReference: transaction.reference
        }
      });
    }
    
    // Search in VirtualAccount table
    const virtualAccount = await VirtualAccount.findOne({
      $or: [
        { cashwyreRequestId: searchRef },
        { cashwyreReference: searchRef },
        { reference: searchRef }
      ]
    });
    
    if (virtualAccount && virtualAccount.amount) {
      console.log('✅ Found virtual account with matching ID');
      console.log('   User ID:', virtualAccount.userId);
      console.log('   Amount:', virtualAccount.amount);
      
      // Check Cashwyre for status
      const requestId = `${Date.now()}${Math.random().toString(36).substring(2, 10)}`;
      
      try {
        const response = await axios.post(
          `${CASHWYRE_CONFIG.baseURL}/payin/payinStatus`,
          {
            appId: CASHWYRE_CONFIG.appId,
            requestId: requestId,
            transactionReference: virtualAccount.cashwyreRequestId,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${CASHWYRE_CONFIG.secretKey}`,
            },
            timeout: 15000
          }
        );
        
        console.log('📊 Cashwyre Status Response:', JSON.stringify(response.data));
        
        if (response.data.success && response.data.data) {
          const status = response.data.data.status;
          const amount = parseFloat(response.data.data.depositAmount || 0);
          
          if (status === 'completed' || status === 'success') {
            await updateWalletBalance(
              virtualAccount.userId,
              amount,
              'credit',
              response.data.data.transactionReference || virtualAccount.cashwyreRequestId,
              'Payin status check - successful',
              { source: 'payin_status_check', cashwyreData: response.data.data }
            );
            
            return res.json({
              success: true,
              status: 'completed',
              amount: amount,
              data: response.data.data
            });
          }
        }
      } catch (cashwyreError) {
        console.log('Cashwyre check error:', cashwyreError.message);
      }
    }
    
    res.json({
      success: false,
      status: 'pending',
      message: 'Payment still pending'
    });
    
  } catch (error) {
    console.error('Payin status check error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: error.message,
      status: 'error'
    });
  }
});




app.get('/api/webhooks/test', (req, res) => {
  console.log('✅ TEST WEBHOOK ENDPOINT HIT');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Query:', JSON.stringify(req.query, null, 2));
  res.json({ success: true, message: 'Webhook endpoint is reachable' });
});


// ==================== SYNC ENDPOINT FOR PHP WEBHOOK ====================
app.post('/api/webhooks/cashwyre-sync', async (req, res) => {
  // ADD THESE LOGS INSIDE THE ROUTE HANDLER
  console.log('🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥');
  console.log('WEBHOOK RECEIVED BY NODE.JS SERVER');
  console.log('Time:', new Date().toISOString());
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥');
  
  const startTime = Date.now();
  console.log('='.repeat(80));
  console.log('🔄 CASHWYRE SYNC RECEIVED');
  console.log('Time:', new Date().toISOString());
  console.log('Payload:', JSON.stringify(req.body, null, 2));
  
  // ALWAYS send 200 response immediately to acknowledge receipt
  res.status(200).json({ success: true, message: 'Webhook received - processing' });
  
  // Continue processing asynchronously
  try {
    const { userId, amount, reference, cashwyreCode, accountNumber, bankName, sourceOfPayment, amountPaid, amountSettled, transactionId, settledOn, type } = req.body;
    
    if (!userId || !amount) {
      console.log('❌ Missing required fields');
      return;
    }
    
    console.log(`💰 Webhook data: User requested ₦${amount}, Amount Paid: ₦${amountPaid}, Amount Settled: ₦${amountSettled}`);
    
    // Find the user
    const user = await User.findById(userId);
    if (!user) {
      console.log('❌ User not found:', userId);
      return;
    }
    
    // IMPORTANT: Credit the original amount the user wanted to fund
    // This is the amount they entered in the app (e.g., 100)
    const creditAmount = parseFloat(amount);
    
    console.log(`💰 WILL CREDIT USER: ₦${creditAmount} (This is what they will see in their wallet)`);
    console.log(`💰 Service charge deducted by payment provider: ₦${(amountPaid - creditAmount).toFixed(2)}`);
    
    // SEARCH FOR PENDING TRANSACTION
    let pendingTransaction = await Transaction.findOne({ 
      $or: [
        { reference: cashwyreCode },
        { cashwyreReference: cashwyreCode },
        { 'metadata.requestId': cashwyreCode },
        { reference: reference },
        { 'metadata.accountNumber': accountNumber }
      ],
      status: 'pending'
    });
    
    if (!pendingTransaction) {
      pendingTransaction = await Transaction.findOne({
        userId: userId,
        'metadata.accountNumber': accountNumber,
        status: 'pending'
      });
    }
    
    let transaction;
    let oldBalance;
    let newBalance;
    
    if (pendingTransaction) {
      console.log('✅ Found pending transaction, updating to completed:', pendingTransaction._id);
      
      oldBalance = user.walletBalance;
      newBalance = oldBalance + creditAmount;  // CREDIT THE USER'S REQUESTED AMOUNT
      
      user.walletBalance = newBalance;
      user.updatedAt = new Date();
      await user.save();
      
      pendingTransaction.status = 'completed';
      pendingTransaction.newBalance = newBalance;
      pendingTransaction.previousBalance = oldBalance;
      pendingTransaction.cashwyreReference = cashwyreCode;
      pendingTransaction.completedAt = new Date(settledOn || new Date());
      pendingTransaction.description = `Virtual Account Funding - ₦${creditAmount} credited to wallet`;
      pendingTransaction.metadata = {
        ...pendingTransaction.metadata,
        source: 'cashwyre_webhook_sync',
        accountNumber: accountNumber,
        bankName: bankName,
        sourceOfPayment: sourceOfPayment,
        amountPaid: amountPaid,
        amountSettled: amountSettled,
        originalTransactionId: transactionId,
        settledOn: settledOn,
        cashwyreCode: cashwyreCode,
        paymentCompletedAt: new Date(),
        status: 'completed',
        creditedAmount: creditAmount,
        serviceChargeDeducted: amountPaid - creditAmount
      };
      
      transaction = await pendingTransaction.save();
      console.log(`✅ UPDATED pending transaction to completed: ${transaction._id}`);
      console.log(`💰 User wallet credited: ₦${creditAmount}`);
      console.log(`💰 New balance: ₦${newBalance}`);
      
    } else {
      console.log('⚠️ No pending transaction found, creating new completed transaction');
      
      oldBalance = user.walletBalance;
      newBalance = oldBalance + creditAmount;  // CREDIT THE USER'S REQUESTED AMOUNT
      
      user.walletBalance = newBalance;
      user.updatedAt = new Date();
      await user.save();
      
      transaction = new Transaction({
        userId: user._id,
        type: 'wallet_funding',
        amount: creditAmount,  // Store the credited amount
        previousBalance: oldBalance,
        newBalance: newBalance,
        reference: cashwyreCode || reference,
        cashwyreReference: cashwyreCode,
        status: 'completed',
        description: `Virtual Account Funding - ₦${creditAmount} credited to wallet`,
        metadata: {
          source: 'cashwyre_webhook_sync',
          accountNumber: accountNumber,
          bankName: bankName,
          sourceOfPayment: sourceOfPayment,
          amountPaid: amountPaid,
          amountSettled: amountSettled,
          originalTransactionId: transactionId,
          settledOn: settledOn,
          cashwyreCode: cashwyreCode,
          paymentCompletedAt: new Date(),
          creditedAmount: creditAmount,
          serviceChargeDeducted: amountPaid - creditAmount
        },
        completedAt: new Date(settledOn || new Date())
      });
      
      await transaction.save();
      console.log(`✅ Created new completed transaction: ${transaction._id}`);
      console.log(`💰 User wallet credited: ₦${creditAmount}`);
      console.log(`💰 New balance: ₦${newBalance}`);
    }
    
    const duration = Date.now() - startTime;
    console.log('✅ SYNC COMPLETED in ' + duration + 'ms');
    console.log('='.repeat(80));
    
  } catch (error) {
    console.error('❌ Sync error:', error.message);
    console.error('Stack:', error.stack);
    console.log('='.repeat(80));
  }
});



// Add this endpoint to get pending transactions for a user
app.get('/api/transactions/pending/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const pendingTransactions = await Transaction.find({
      userId: userId,
      status: 'pending'
    }).sort({ createdAt: -1 });
    
    console.log(`📋 Found ${pendingTransactions.length} pending transactions for user ${userId}`);
    
    res.json({
      success: true,
      transactions: pendingTransactions,
      count: pendingTransactions.length
    });
  } catch (error) {
    console.error('Error fetching pending transactions:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});



// Add endpoint to get ALL transactions (pending + completed)
// Get ALL transactions for a user (both pending and completed)
app.get('/api/transactions/all/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        console.log(`📋 Fetching ALL transactions for user: ${userId}`);
        
        const transactions = await Transaction.find({ userId: userId })
            .sort({ createdAt: -1 });
        
        console.log(`📋 Found ${transactions.length} total transactions for user ${userId}`);
        
        res.json({
            success: true,
            transactions: transactions,
            count: transactions.length
        });
    } catch (error) {
        console.error('Error fetching all transactions:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});






// ============================================
// PROCESS CASHWYRE WEBHOOK - SAVES TO MONGODB
// ============================================
app.post('/api/webhooks/cashwyre-process', async (req, res) => {
    console.log('💰💰💰 CASHWYRE WEBHOOK RECEIVED BY NODE.JS 💰💰💰');
    console.log('Time:', new Date().toISOString());
    console.log('Body:', JSON.stringify(req.body, null, 2));
    
    res.status(200).json({ success: true, message: 'Processing' });
    
    try {
        const { cashwyreCode, amountPaid, accountNumber, status, bankName, settledOn, isOverpaid } = req.body;
        
        console.log(`📋 Processing for account: ${accountNumber}`);
        
        // Find virtual account
        const virtualAccount = await VirtualAccount.findOne({ 
            accountNumber: accountNumber,
            active: true
        }).sort({ createdAt: -1 });
        
        if (!virtualAccount) {
            console.log('❌ No virtual account found for:', accountNumber);
            return;
        }
        
        const user = await User.findById(virtualAccount.userId);
        if (!user) {
            console.log('❌ User not found:', virtualAccount.userId);
            return;
        }
        
        const creditAmount = virtualAccount.amount;
        const oldBalance = user.walletBalance;
        const newBalance = oldBalance + creditAmount;
        
        // Update user balance
        user.walletBalance = newBalance;
        user.updatedAt = new Date();
        await user.save();
        
        // Deactivate virtual account
        virtualAccount.active = false;
        virtualAccount.processedAt = new Date();
        virtualAccount.cashwyreReference = cashwyreCode;
        await virtualAccount.save();
        
        // CRITICAL: Save or update transaction in MongoDB
        let pendingTransaction = await Transaction.findOne({ 
            userId: virtualAccount.userId,
            status: 'pending',
            'metadata.accountNumber': accountNumber
        });
        
        if (pendingTransaction) {
            // Update existing pending to completed
            pendingTransaction.status = 'completed';
            pendingTransaction.newBalance = newBalance;
            pendingTransaction.previousBalance = oldBalance;
            pendingTransaction.cashwyreReference = cashwyreCode;
            pendingTransaction.completedAt = new Date(settledOn || new Date());
            pendingTransaction.description = `Virtual Account Funding - ₦${creditAmount} credited to wallet`;
            pendingTransaction.metadata = {
                ...pendingTransaction.metadata,
                source: 'cashwyre_webhook',
                amountPaid: amountPaid,
                status: status,
                settledOn: settledOn,
                isOverpaid: isOverpaid || false,
                permanentlySaved: true
            };
            await pendingTransaction.save();
            console.log('✅ Updated pending transaction to completed');
        } else {
            // Create NEW completed transaction
            const newTransaction = new Transaction({
                userId: user._id,
                type: 'wallet_funding',
                amount: creditAmount,
                previousBalance: oldBalance,
                newBalance: newBalance,
                reference: cashwyreCode,
                cashwyreReference: cashwyreCode,
                status: 'completed',
                description: `Virtual Account Funding - ₦${creditAmount} credited to wallet`,
                metadata: {
                    source: 'cashwyre_webhook',
                    accountNumber: accountNumber,
                    amountPaid: amountPaid,
                    status: status,
                    settledOn: settledOn,
                    isOverpaid: isOverpaid || false,
                    permanentlySaved: true
                },
                completedAt: new Date(settledOn || new Date())
            });
            await newTransaction.save();
            console.log('✅ Created new completed transaction');
        }
        
        console.log(`✅ User ${user.email} credited: ₦${creditAmount}`);
        console.log(`💰 Balance: ₦${oldBalance} → ₦${newBalance}`);
        
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
    }
});





// ==================== WEBHOOK ====================
app.post('/api/webhooks/cashwyre', async (req, res) => {
  try {
    console.log('Webhook received:', req.rawBody?.toString() || JSON.stringify(req.body));
    
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
          console.log(`✅ Processed deposit: ₦${amount} for user ${virtualAccount.userId}`);
        }
      }
    }
    
    res.status(200).json({ success: true, message: 'Webhook received' });
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== CASHWYRE FIAT DEPOSIT WEBHOOK ====================
app.post('/api/webhooks/cashwyre-fiat', async (req, res) => {
  try {
    console.log('💰 Cashwyre Fiat Deposit Webhook Received');
    console.log('Raw body:', req.rawBody?.toString());
    console.log('Parsed body:', JSON.stringify(req.body, null, 2));
    
    let webhookData;
    if (req.rawBody) {
      webhookData = JSON.parse(req.rawBody.toString());
    } else {
      webhookData = req.body;
    }
    
    const { eventType, eventData } = webhookData;
    
    if (eventType === 'fiat_deposit.success' || eventType === 'fiat.deposit.success') {
      console.log('✅ Processing fiat deposit webhook');
      
      const {
        Code,
        AmountPaid,
        AmountSettled,
        Currency,
        AccountNumber,
        AccountName,
        BankName,
        BankCode,
        Country,
        Narration,
        Status,
        RequestId,
        SettledOn,
        SourceOfPayment,
        FundingMethod
      } = eventData;
      
      if (Status !== 'success') {
        console.log(`⚠️ Payment not successful: ${Status}`);
        return res.status(200).json({ success: false, message: 'Payment not successful' });
      }
      
      const virtualAccount = await VirtualAccount.findOne({ 
        accountNumber: AccountNumber,
        active: true
      }).sort({ createdAt: -1 });
      
      if (!virtualAccount) {
        console.log(`❌ Virtual account not found for: ${AccountNumber}`);
        
        await UnmatchedWebhook.create({
          reference: Code,
          payload: req.body,
          receivedAt: new Date()
        });
        
        return res.status(200).json({ success: false, message: 'Virtual account not found' });
      }
      
      console.log(`✅ Found virtual account for user: ${virtualAccount.userId}`);
      
      const amount = parseFloat(AmountSettled || AmountPaid || 0);
      const reference = `CASHWYRE_${Code || RequestId || Date.now()}`;
      
      const existingTx = await Transaction.findOne({ reference });
      if (existingTx) {
        console.log(`⚠️ Transaction already processed: ${reference}`);
        return res.status(200).json({ success: true, message: 'Already processed' });
      }
      
      const existingByCashwyre = await Transaction.findOne({ cashwyreReference: Code || RequestId });
      if (existingByCashwyre) {
        console.log(`⚠️ Transaction already processed by cashwyre ref: ${Code || RequestId}`);
        return res.status(200).json({ success: true, message: 'Already processed' });
      }
      
      const result = await updateWalletBalance(
        virtualAccount.userId,
        amount,
        'credit',
        reference,
        Narration || `Deposit from ${BankName} - ${AccountNumber}`,
        {
          source: 'cashwyre_webhook',
          paymentMethod: FundingMethod || 'bank_transfer',
          bankName: BankName,
          bankCode: BankCode,
          accountNumber: AccountNumber,
          accountName: AccountName,
          currency: Currency || 'NGN',
          cashwyreCode: Code,
          cashwyreRequestId: RequestId,
          settledOn: SettledOn,
          sourceOfPayment: SourceOfPayment
        }
      );
      
      virtualAccount.cashwyreReference = Code || RequestId;
      virtualAccount.processedAt = new Date();
      await virtualAccount.save();
      
      console.log(`✅ Successfully processed deposit: ₦${amount} for user ${virtualAccount.userId}`);
      console.log(`💰 New balance: ₦${result.newBalance}`);
      
      return res.status(200).json({ 
        success: true, 
        message: 'Deposit processed successfully',
        amount: amount,
        newBalance: result.newBalance
      });
      
    } else {
      console.log(`⚠️ Unhandled event type: ${eventType}`);
      return res.status(200).json({ success: false, message: 'Unhandled event type' });
    }
    
  } catch (error) {
    console.error('❌ Cashwyre webhook error:', error.message);
    return res.status(200).json({ success: false, message: error.message });
  }
});



// Add to server.js - Check sync status
app.get('/api/sync/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.json({ success: false, message: 'User not found' });
    }
    
    const lastTransaction = await Transaction.findOne({ userId: userId })
      .sort({ completedAt: -1 })
      .limit(1);
    
    res.json({
      success: true,
      walletBalance: user.walletBalance,
      lastTransaction: lastTransaction ? {
        amount: lastTransaction.amount,
        status: lastTransaction.status,
        date: lastTransaction.completedAt,
        source: lastTransaction.metadata?.source
      } : null
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});













// ============================================
// CHECK CASHWYRE TRANSACTION IN MONGODB
// ============================================
app.get('/api/payments/check-cashwyre-transaction/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    const { userId } = req.query;
    
    console.log('🔍 Checking Cashwyre transaction:', reference);
    
    // Search in VirtualAccount table
    const virtualAccount = await VirtualAccount.findOne({
      $or: [
        { cashwyreRequestId: reference },
        { cashwyreReference: reference },
        { reference: reference }
      ]
    });
    
    if (virtualAccount) {
      // Check if already processed
      const existingTransaction = await Transaction.findOne({
        $or: [
          { cashwyreReference: reference },
          { reference: reference }
        ],
        status: 'completed'
      });
      
      return res.json({
        exists: true,
        alreadyProcessed: existingTransaction != null,
        userId: virtualAccount.userId,
        amount: virtualAccount.amount,
        totalPayable: virtualAccount.totalPayable,
        status: existingTransaction ? 'completed' : 'pending',
        expiresOn: virtualAccount.expiresOn
      });
    }
    
    // Search in Transaction table
    const transaction = await Transaction.findOne({
      $or: [
        { reference: reference },
        { cashwyreReference: reference }
      ]
    });
    
    if (transaction) {
      return res.json({
        exists: true,
        alreadyProcessed: transaction.status === 'completed',
        userId: transaction.userId,
        amount: transaction.amount,
        status: transaction.status
      });
    }
    
    res.json({ exists: false });
    
  } catch (error) {
    console.error('Check transaction error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// PROCESS CASHWYRE PAYMENT AND CREDIT USER
// ============================================
app.post('/api/payments/process-cashwyre-payment', async (req, res) => {
  try {
    const { userId, reference, amount, depositAmount, feeAmount, isPartial, isOverpaid, source } = req.body;
    
    console.log('💰 Processing Cashwyre payment credit:');
    console.log('   User ID:', userId);
    console.log('   Reference:', reference);
    console.log('   Amount to credit: ₦${amount}');
    console.log('   Deposit Amount: ₦${depositAmount}');
    console.log('   Fee Amount: ₦${feeAmount}');
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    // Check if already processed
    const existingTx = await Transaction.findOne({
      $or: [
        { reference: reference },
        { cashwyreReference: reference }
      ]
    });
    
    if (existingTx && existingTx.status === 'completed') {
      return res.json({
        success: true,
        alreadyProcessed: true,
        newBalance: user.walletBalance,
        message: 'Transaction already processed'
      });
    }
    
    const oldBalance = user.walletBalance;
    const creditAmount = amount; // Credit the original amount
    const newBalance = oldBalance + creditAmount;
    
    // Update user balance
    user.walletBalance = newBalance;
    user.updatedAt = new Date();
    await user.save();
    
    // Update virtual account if exists
    const virtualAccount = await VirtualAccount.findOne({
      $or: [
        { cashwyreRequestId: reference },
        { cashwyreReference: reference },
        { reference: reference }
      ]
    });
    
    if (virtualAccount) {
      virtualAccount.active = false;
      virtualAccount.processedAt = new Date();
      virtualAccount.cashwyreReference = reference;
      await virtualAccount.save();
    }
    
    // Create transaction record
    const transaction = new Transaction({
      userId: user._id,
      type: 'wallet_funding',
      amount: creditAmount,
      previousBalance: oldBalance,
      newBalance: newBalance,
      reference: reference,
      cashwyreReference: reference,
      status: 'completed',
      description: `Cashwyre Virtual Account Funding - ₦${creditAmount} credited to wallet${isPartial ? ' (Partial payment)' : ''}${isOverpaid ? ' (Overpaid - credited original)' : ''}`,
      metadata: {
        source: source || 'transaction_validation_page',
        depositAmount: depositAmount,
        feeAmount: feeAmount,
        isPartial: isPartial || false,
        isOverpaid: isOverpaid || false,
        verifiedAt: new Date()
      },
      completedAt: new Date()
    });
    
    await transaction.save();
    
    console.log(`✅ User ${user.email} credited: ₦${creditAmount}`);
    console.log(`💰 New balance: ₦${newBalance}`);
    
    res.json({
      success: true,
      newBalance: newBalance,
      amount: creditAmount,
      message: 'Payment processed successfully'
    });
    
  } catch (error) {
    console.error('Process payment error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});






// ============================================
// FIX: Recover missing balance for existing transactions
// ============================================
app.post('/api/admin/recover-missing-balance', async (req, res) => {
  try {
    const { userId, reference } = req.body;
    
    console.log('🔄 Recovering missing balance for:', reference);
    
    // Find the pending/completed transaction
    const transaction = await Transaction.findOne({
      $or: [
        { reference: reference },
        { cashwyreReference: reference },
        { 'metadata.cashwyreCode': reference }
      ]
    });
    
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }
    
    const user = await User.findById(transaction.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    // Check if balance was already updated
    if (transaction.newBalance > 0 && transaction.newBalance !== transaction.previousBalance) {
      return res.json({
        success: true,
        message: 'Balance already correct',
        currentBalance: user.walletBalance,
        transactionBalance: transaction.newBalance
      });
    }
    
    // Calculate correct balance
    const oldBalance = user.walletBalance;
    const amountToCredit = transaction.amount;
    const newBalance = oldBalance + amountToCredit;
    
    // Update user balance
    user.walletBalance = newBalance;
    user.updatedAt = new Date();
    await user.save();
    
    // Update transaction
    transaction.newBalance = newBalance;
    transaction.previousBalance = oldBalance;
    transaction.status = 'completed';
    transaction.completedAt = new Date();
    transaction.metadata = {
      ...transaction.metadata,
      balanceRecovered: true,
      recoveredAt: new Date(),
      oldBalanceBeforeRecovery: oldBalance
    };
    await transaction.save();
    
    console.log(`✅ Recovered ₦${amountToCredit} for user ${user.email}`);
    console.log(`💰 Balance: ₦${oldBalance} → ₦${newBalance}`);
    
    res.json({
      success: true,
      amountRecovered: amountToCredit,
      oldBalance: oldBalance,
      newBalance: newBalance,
      message: 'Balance recovered successfully'
    });
    
  } catch (error) {
    console.error('Recovery error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});




// ============================================
// USER RECOVER MISSING BALANCE - SAVES TO MONGODB
// ============================================
app.post('/api/recover-missing-balance', async (req, res) => {
  try {
    const { userId, reference } = req.body;
    
    console.log('🔄 User requested balance recovery for:', reference);
    console.log('   User ID:', userId);
    
    if (!reference) {
      return res.status(400).json({ 
        success: false, 
        message: 'Transaction reference is required' 
      });
    }
    
    // First, check if this transaction already exists in MongoDB
    let existingTransaction = await Transaction.findOne({
      $or: [
        { reference: reference },
        { cashwyreReference: reference },
        { 'metadata.cashwyreCode': reference },
        { 'metadata.requestId': reference }
      ]
    });
    
    if (existingTransaction) {
      console.log('✅ Transaction found in MongoDB');
      
      // Check if already credited
      if (existingTransaction.status === 'completed' && existingTransaction.newBalance > existingTransaction.previousBalance) {
        return res.json({
          success: true,
          alreadyProcessed: true,
          message: 'This transaction was already credited to your wallet.',
          amount: existingTransaction.amount,
          newBalance: existingTransaction.newBalance
        });
      }
      
      // Get user
      const user = await User.findById(existingTransaction.userId);
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      
      // Check ownership
      if (userId && user._id.toString() !== userId.toString()) {
        return res.status(403).json({ success: false, message: 'This transaction does not belong to your account.' });
      }
      
      // Credit the user
      const oldBalance = user.walletBalance;
      const creditAmount = existingTransaction.amount;
      const newBalance = oldBalance + creditAmount;
      
      user.walletBalance = newBalance;
      user.updatedAt = new Date();
      await user.save();
      
      existingTransaction.status = 'completed';
      existingTransaction.newBalance = newBalance;
      existingTransaction.previousBalance = oldBalance;
      existingTransaction.completedAt = new Date();
      existingTransaction.metadata = {
        ...existingTransaction.metadata,
        balanceRecovered: true,
        recoveredAt: new Date(),
        recoveredBy: userId
      };
      await existingTransaction.save();
      
      console.log(`✅ Recovered ₦${creditAmount} for user ${user.email}`);
      console.log(`💰 Balance: ₦${oldBalance} → ₦${newBalance}`);
      
      return res.json({
        success: true,
        amountRecovered: creditAmount,
        oldBalance: oldBalance,
        newBalance: newBalance,
        message: `Successfully recovered ₦${creditAmount.toFixed(2)} to your wallet!`
      });
    }
    
    // If not found in MongoDB, check MySQL via your PHP webhook data
    console.log('⚠️ Transaction not found in MongoDB, checking MySQL records...');
    
    // For the 3 transactions from your logs, create them in MongoDB
    // This handles the transactions that only exist in MySQL
    const knownTransactions = {
      'MNFY|87|20260409234344|158580': {
        amount: 100, // User requested amount
        amountPaid: 121.8,
        accountNumber: '6660155501',
        status: 'PAID'
      },
      'MNFY|96|20260409235007|058483': {
        amount: 100, // User requested amount
        amountPaid: 150.0,
        accountNumber: '6660689873',
        status: 'OVERPAID'
      },
      'MNFY|11|20260410003422|385303': {
        amount: 100, // User requested amount
        amountPaid: 101.5,
        accountNumber: '6660589739',
        status: 'PAID'
      }
    };
    
    if (knownTransactions[reference]) {
      console.log('✅ Found transaction in known records, creating in MongoDB...');
      
      const txData = knownTransactions[reference];
      
      // Find user by userId or by account number association
      let user = await User.findById(userId);
      if (!user) {
        // Try to find user by email from your app_users table
        // For now, use the provided userId
        user = await User.findById(userId);
        if (!user) {
          return res.status(404).json({ success: false, message: 'User not found. Please make sure you are logged in.' });
        }
      }
      
      const oldBalance = user.walletBalance;
      const creditAmount = txData.amount; // Credit the original amount (₦100)
      const newBalance = oldBalance + creditAmount;
      
      // Update user balance
      user.walletBalance = newBalance;
      user.updatedAt = new Date();
      await user.save();
      
      // Create transaction in MongoDB
      const newTransaction = new Transaction({
        userId: user._id,
        type: 'wallet_funding',
        amount: creditAmount,
        previousBalance: oldBalance,
        newBalance: newBalance,
        reference: reference,
        cashwyreReference: reference,
        status: 'completed',
        description: `Cashwyre Virtual Account Funding - ₦${creditAmount} credited to wallet (Recovered from MySQL)`,
        metadata: {
          source: 'user_balance_recovery',
          accountNumber: txData.accountNumber,
          amountPaid: txData.amountPaid,
          status: txData.status,
          recoveredAt: new Date(),
          recoveredBy: userId,
          originalSource: 'mysql_webhook'
        },
        completedAt: new Date()
      });
      
      await newTransaction.save();
      
      console.log(`✅ Created transaction in MongoDB and credited ₦${creditAmount} for user ${user.email}`);
      console.log(`💰 Balance: ₦${oldBalance} → ₦${newBalance}`);
      
      return res.json({
        success: true,
        amountRecovered: creditAmount,
        oldBalance: oldBalance,
        newBalance: newBalance,
        message: `Successfully recovered ₦${creditAmount.toFixed(2)} to your wallet!`
      });
    }
    
    // If all else fails
    return res.status(404).json({ 
      success: false, 
      message: 'Transaction not found. Please check your reference and try again, or contact support.' 
    });
    
  } catch (error) {
    console.error('Recovery error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while recovering your transaction. Please try again or contact support.' 
    });
  }
});




// ============================================
// CREATE PENDING TRANSACTION (When user initiates funding)
// ============================================
app.post('/api/transactions/create-pending', async (req, res) => {
    try {
        const { userId, amount, reference, accountNumber, totalPayable, fee } = req.body;
        
        if (!userId || !amount) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }
        
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        const currentBalance = user.walletBalance;
        
        // Check if transaction already exists
        const existing = await Transaction.findOne({ reference: reference });
        if (existing) {
            return res.json({ success: true, alreadyExists: true, transaction: existing });
        }
        
        // Create pending transaction
        const transaction = new Transaction({
            userId: user._id,
            type: 'wallet_funding',
            amount: amount,
            previousBalance: currentBalance,
            newBalance: currentBalance,
            reference: reference,
            cashwyreReference: reference,
            status: 'pending',
            description: `Pending Cashwyre funding - ₦${amount}`,
            metadata: {
                source: 'cashwyre_pending',
                accountNumber: accountNumber,
                totalPayable: totalPayable,
                fee: fee,
                initiatedAt: new Date()
            },
            completedAt: null
        });
        
        await transaction.save();
        
        console.log(`📝 Pending transaction created: ${reference}`);
        
        res.json({
            success: true,
            transaction: transaction,
            message: 'Pending transaction created successfully'
        });
        
    } catch (error) {
        console.error('Create pending error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});





// ============================================
// USER RECOVER MISSING BALANCE - SAVES TO MONGODB
// ============================================
app.post('/api/recover-missing-balance', async (req, res) => {
  try {
    const { userId, reference } = req.body;
    
    console.log('🔄 User requested balance recovery for:', reference);
    console.log('   User ID:', userId);
    
    if (!reference) {
      return res.status(400).json({ 
        success: false, 
        message: 'Transaction reference is required' 
      });
    }
    
    // Find the user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found. Please log in again.' 
      });
    }
    
    // Check if transaction already exists in MongoDB
    let existingTransaction = await Transaction.findOne({
      $or: [
        { reference: reference },
        { cashwyreReference: reference },
        { 'metadata.cashwyreCode': reference },
        { 'metadata.requestId': reference }
      ]
    });
    
    if (existingTransaction) {
      // Check if already credited
      if (existingTransaction.status === 'completed' && existingTransaction.newBalance > existingTransaction.previousBalance) {
        return res.json({
          success: true,
          alreadyProcessed: true,
          message: 'This transaction was already credited to your wallet.',
          amount: existingTransaction.amount,
          newBalance: existingTransaction.newBalance
        });
      }
      
      // Credit the user
      const oldBalance = user.walletBalance;
      const creditAmount = existingTransaction.amount;
      const newBalance = oldBalance + creditAmount;
      
      user.walletBalance = newBalance;
      user.updatedAt = new Date();
      await user.save();
      
      existingTransaction.status = 'completed';
      existingTransaction.newBalance = newBalance;
      existingTransaction.previousBalance = oldBalance;
      existingTransaction.completedAt = new Date();
      existingTransaction.metadata = {
        ...existingTransaction.metadata,
        balanceRecovered: true,
        recoveredAt: new Date(),
        recoveredBy: userId
      };
      await existingTransaction.save();
      
      console.log(`✅ Recovered ₦${creditAmount} for user ${user.email}`);
      console.log(`💰 Balance: ₦${oldBalance} → ₦${newBalance}`);
      
      return res.json({
        success: true,
        amountRecovered: creditAmount,
        oldBalance: oldBalance,
        newBalance: newBalance,
        message: `Successfully recovered ₦${creditAmount.toFixed(2)} to your wallet!`
      });
    }
    
    // Transaction not found in MongoDB - Create from known data
    // Map of references from your webhook logs
    const knownTransactions = {
      'MNFY|87|20260409234344|158580': {
        amount: 100,
        amountPaid: 121.8,
        accountNumber: '6660155501',
        status: 'PAID',
        settledOn: '2026-04-09 23:45:10.0'
      },
      'MNFY|96|20260409235007|058483': {
        amount: 100,
        amountPaid: 150.0,
        accountNumber: '6660689873',
        status: 'OVERPAID',
        settledOn: '2026-04-10 00:15:46.0'
      },
      'MNFY|11|20260410003422|385303': {
        amount: 100,
        amountPaid: 101.5,
        accountNumber: '6660589739',
        status: 'PAID',
        settledOn: '2026-04-10 00:36:30.0'
      }
    };
    
    const txData = knownTransactions[reference];
    if (!txData) {
      return res.status(404).json({ 
        success: false, 
        message: 'Transaction not found. Please check your reference and try again.' 
      });
    }
    
    console.log('✅ Found transaction in known records, creating in MongoDB...');
    
    const oldBalance = user.walletBalance;
    const creditAmount = txData.amount; // Credit ₦100 (the original amount user wanted)
    const newBalance = oldBalance + creditAmount;
    
    // Update user balance
    user.walletBalance = newBalance;
    user.updatedAt = new Date();
    await user.save();
    
    // Create transaction in MongoDB
    const newTransaction = new Transaction({
      userId: user._id,
      type: 'wallet_funding',
      amount: creditAmount,
      previousBalance: oldBalance,
      newBalance: newBalance,
      reference: reference,
      cashwyreReference: reference,
      status: 'completed',
      description: `Cashwyre Wallet Funding - ₦${creditAmount} credited to wallet`,
      metadata: {
        source: 'user_balance_recovery',
        accountNumber: txData.accountNumber,
        amountPaid: txData.amountPaid,
        status: txData.status,
        settledOn: txData.settledOn,
        recoveredAt: new Date(),
        recoveredBy: userId,
        originalSource: 'mysql_webhook_recovery'
      },
      completedAt: new Date(txData.settledOn || new Date())
    });
    
    await newTransaction.save();
    
    console.log(`✅ Created transaction in MongoDB: ${newTransaction._id}`);
    console.log(`💰 Credited ₦${creditAmount} to user ${user.email}`);
    console.log(`💰 Balance: ₦${oldBalance} → ₦${newBalance}`);
    
    // Also update virtual account if exists
    const virtualAccount = await VirtualAccount.findOne({ accountNumber: txData.accountNumber });
    if (virtualAccount) {
      virtualAccount.active = false;
      virtualAccount.processedAt = new Date();
      virtualAccount.cashwyreReference = reference;
      await virtualAccount.save();
      console.log(`✅ Updated virtual account: ${virtualAccount.accountNumber}`);
    }
    
    return res.json({
      success: true,
      amountRecovered: creditAmount,
      oldBalance: oldBalance,
      newBalance: newBalance,
      message: `Successfully recovered ₦${creditAmount.toFixed(2)} to your wallet!`,
      transactionId: newTransaction._id
    });
    
  } catch (error) {
    console.error('Recovery error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while recovering your transaction. Please try again or contact support.' 
    });
  }
});




// ==================== MANUAL BALANCE RECOVERY ENDPOINT ====================
app.post('/api/admin/recover-payment', async (req, res) => {
  try {
    const { userId, amount, reference, cashwyreCode, accountNumber } = req.body;
    
    console.log('🔄 MANUAL RECOVERY REQUEST:');
    console.log('   User ID:', userId);
    console.log('   Amount: ₦' + amount);
    console.log('   Cashwyre Code:', cashwyreCode);
    
    if (!userId || !amount) {
      return res.status(400).json({ success: false, message: 'Missing userId or amount' });
    }
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    // Check if already processed
    const existingTx = await Transaction.findOne({ cashwyreReference: cashwyreCode });
    if (existingTx) {
      return res.json({ 
        success: true, 
        message: 'Already processed',
        alreadyProcessed: true,
        newBalance: user.walletBalance
      });
    }
    
    // Update balance
    const oldBalance = user.walletBalance;
    const newBalance = oldBalance + amount;
    
    user.walletBalance = newBalance;
    await user.save();
    
    // Create transaction record
    const transaction = new Transaction({
      userId: user._id,
      type: 'wallet_funding',
      amount: amount,
      previousBalance: oldBalance,
      newBalance: newBalance,
      reference: cashwyreCode || `MANUAL_${Date.now()}`,
      cashwyreReference: cashwyreCode,
      status: 'completed',
      description: `MANUAL RECOVERY: Cashwyre Deposit - ${accountNumber || ''}`,
      metadata: {
        source: 'manual_recovery',
        accountNumber: accountNumber,
        cashwyreCode: cashwyreCode,
        recoveredAt: new Date()
      },
      completedAt: new Date()
    });
    
    await transaction.save();
    
    console.log('✅ MANUAL RECOVERY SUCCESSFUL!');
    console.log('   Old Balance: ₦' + oldBalance);
    console.log('   New Balance: ₦' + newBalance);
    
    res.json({
      success: true,
      message: 'Payment recovered successfully',
      newBalance: newBalance,
      oldBalance: oldBalance,
      transaction: transaction
    });
    
  } catch (error) {
    console.error('Manual recovery error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== GET PENDING TRANSACTIONS ====================
app.get('/api/admin/pending-transactions', async (req, res) => {
  try {
    const pendingTransactions = await VirtualAccount.find({
      active: true,
      expiresOn: { $gt: new Date() }
    }).sort({ createdAt: -1 }).limit(20);
    
    res.json({
      success: true,
      transactions: pendingTransactions,
      count: pendingTransactions.length
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});




// ==================== FORCE BALANCE REFRESH FOR FLUTTER APP ====================
// ==================== FORCE BALANCE REFRESH FOR FLUTTER APP ====================
app.post('/api/wallet/force-refresh', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID required' });
    }
    
    // Check cooldown - prevent multiple calls in short time
    const lastRefresh = forceRefreshCooldown.get(userId);
    const now = Date.now();
    if (lastRefresh && (now - lastRefresh) < FORCE_REFRESH_DELAY) {
      console.log(`⏳ Skipping force refresh for ${userId} - cooldown active (${now - lastRefresh}ms ago)`);
      return res.json({ 
        success: true, 
        message: 'Refresh skipped - cooldown active',
        cooldown: true
      });
    }
    
    // Update last refresh time
    forceRefreshCooldown.set(userId, now);
    
    console.log(`🔄 Force balance refresh requested for user: ${userId}`);
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    // Get the last 5 transactions for this user
    const recentTransactions = await Transaction.find({ userId: userId })
      .sort({ completedAt: -1 })
      .limit(5);
    
    res.json({
      success: true,
      walletBalance: user.walletBalance,
      commissionBalance: user.commissionBalance,
      lastTransaction: recentTransactions.length > 0 ? {
        amount: recentTransactions[0].amount,
        type: recentTransactions[0].type,
        status: recentTransactions[0].status,
        date: recentTransactions[0].completedAt,
        reference: recentTransactions[0].reference
      } : null,
      transactions: recentTransactions,
      message: 'Balance refreshed successfully'
    });
    
  } catch (error) {
    console.error('Force refresh error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});




// ==================== GET LATEST TRANSACTIONS ====================
app.get('/api/transactions/latest/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 10 } = req.query;
    
    const transactions = await Transaction.find({ userId: userId })
      .sort({ completedAt: -1 })
      .limit(parseInt(limit));
    
    res.json({
      success: true,
      transactions: transactions,
      count: transactions.length
    });
    
  } catch (error) {
    console.error('Error fetching latest transactions:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});






// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/cashwyre_wallet')
  .then(async () => {
    console.log('MongoDB connected');
    
    try {
      const db = mongoose.connection.db;
      const collection = db.collection('virtualaccounts');
      
      const collections = await db.listCollections({ name: 'virtualaccounts' }).toArray();
      
      if (collections.length > 0) {
        const indexes = await collection.indexes();
        console.log('Current indexes:', indexes.map(i => ({ name: i.name, unique: i.unique || false })));
        
        const userIdIndex = indexes.find(idx => idx.name === 'userId_1');
        if (userIdIndex) {
          await collection.dropIndex('userId_1');
          console.log('✅ Successfully dropped unique index: userId_1');
        }
        
        const accountNumberIndex = indexes.find(idx => idx.name === 'accountNumber_1');
        if (!accountNumberIndex) {
          await collection.createIndex({ accountNumber: 1 }, { unique: true });
          console.log('✅ Created unique index on accountNumber');
        }
        
        await collection.createIndex({ userId: 1, createdAt: -1 });
        console.log('✅ Created compound index on userId + createdAt');
        
      } else {
        console.log('Collection virtualaccounts does not exist yet, will be created on first save');
      }
      
    } catch (err) {
      console.log('Index cleanup warning:', err.message);
    }





  // Test endpoint for PHP to Node.js connection
app.post('/api/webhooks/test-forward', (req, res) => {
  console.log('🧪🧪🧪 TEST WEBHOOK FORWARDING RECEIVED 🧪🧪🧪');
  console.log('Time:', new Date().toISOString());
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('🧪🧪🧪 END TEST 🧪🧪🧪');
  
  res.json({ 
    success: true, 
    message: 'Test webhook received successfully!',
    receivedAt: new Date().toISOString(),
    echo: req.body
  });
});




    
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Cashwyre Business Code: ${CASHWYRE_CONFIG.businessCode}`);
      console.log(`Currency: ${CASHWYRE_CONFIG.currency}`);
      console.log(`API URL: http://localhost:${PORT}/api/virtual-accounts/create-dynamic`);
      console.log(`Payin Status URL: http://localhost:${PORT}/api/payin/check-status`);
      console.log(`Sync URL: http://localhost:${PORT}/api/webhooks/cashwyre-sync`);
    });
  })
  .catch(err => console.error('MongoDB error:', err));
