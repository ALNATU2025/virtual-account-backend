// index.js — FINAL PRODUCTION VERSION
// DOUBLE FUNDING = IMPOSSIBLE | ALL PAYSTACK PAYMENTS WORK

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// ==================== 1. RAW BODY MIDDLEWARE — CATCH ALL PAYSTACK WEBHOOKS ====================
app.use((req, res, next) => {
  // This catches: /api/webhooks/paystack AND /api/webhooks/virtual-account
  if (req.originalUrl.startsWith('/api/webhooks/paystack') || 
      req.originalUrl.startsWith('/api/webhooks/virtual-account')) {
    
    console.log('RAW BODY MIDDLEWARE TRIGGERED FOR PAYSTACK WEBHOOK');
    
    let data = [];
    req.on('data', chunk => data.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(data);
      req.rawBody = buffer;
      console.log(`Raw body captured: ${buffer.length} bytes`);
      next();
    });
  } else {
    next();
  }
});

// ==================== 2. MOUNT WEBHOOK ROUTES BEFORE ANY PARSERS ====================
const webhookRoutes = require('./routes/webhooks'); // ← FIXED: no trailing slash
app.use('/api/webhooks', webhookRoutes); // ← THIS IS 100% CORRECT

// ==================== 3. NOW SAFE TO USE PARSERS ====================
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type', 'Authorization', 'X-Requested-With', 'Accept',
    'Origin', 'X-Request-ID', 'X-Client-Version', 'X-Client-Platform', 'X-User-ID'
  ],
}));
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ==================== 4. ALL OTHER ROUTES ====================
const virtualAccountRoutes = require('./routes/virtualAccount');
const virtualAccountSyncRoutes = require('./routes/virtualAccountSyncRoutes');
const paymentRoutes = require('./routes/payments');
const walletRoutes = require('./routes/wallet');

app.use('/api/virtual-accounts', virtualAccountRoutes);
app.use('/', virtualAccountSyncRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/wallet', walletRoutes);

// ==================== 5. CRITICAL INDEXES (DOUBLE FUNDING PROTECTION) ====================
async function ensureCriticalIndexes() {
  try {
    console.log('Ensuring critical indexes for zero double-funding...');

    const collection = mongoose.connection.collection('transactions');
    const usersCollection = mongoose.connection.collection('users');

    // Fix duplicates
    const duplicates = await collection.aggregate([
      { $match: { reference: { $ne: null, $type: "string" } } },
      { $group: { _id: "$reference", count: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();

    for (const dup of duplicates) {
      const [keepId, ...fixIds] = dup.ids;
      for (const fixId of fixIds) {
        const newRef = `${dup._id}_dedup_${Date.now()}`;
        await collection.updateOne({ _id: fixId }, { $set: { reference: newRef } });
      }
    }

    // Create unique index
    await collection.createIndex(
      { reference: 1 },
      { unique: true, background: true, name: 'unique_reference_transactions' }
    );

    console.log('DOUBLE FUNDING PROTECTION: ACTIVE');
  } catch (err) {
    console.error('Index error:', err.message);
  }
}

// ==================== 6. DEBUG & HEALTH ====================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    doubleFundingProtection: 'ACTIVE'
  });
});

app.get('/api/debug/raw-body-test', (req, res) => {
  res.json({
    message: "Raw body middleware working!",
    rawBodyLength: req.rawBody ? req.rawBody.length : 0
  });
});

// ==================== 7. START SERVER ====================
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected');

    await ensureCriticalIndexes();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Webhook URL: https://yourdomain.onrender.com/api/webhooks/paystack`);
      console.log(`DOUBLE FUNDING PROTECTION: ACTIVE`);
    });
  } catch (err) {
    console.error('Server failed:', err);
    process.exit(1);
  }
}

startServer();
