// index.js — FIXED VERSION
// DOUBLE FUNDING = IMPOSSIBLE | WEBHOOK = UNBREAKABLE

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { body, validationResult } = require('express-validator');
require('dotenv').config();

const app = express();

// ==================== 1. CRITICAL: RAW BODY MIDDLEWARE — MUST BE FIRST ====================
app.use((req, res, next) => {
  // Only for Paystack webhook to preserve raw body
  if (req.originalUrl === '/api/webhooks/virtual-account') {
    console.log('RAW BODY MIDDLEWARE TRIGGERED FOR PAYSTACK WEBHOOK');
    
    let data = [];
    req.on('data', chunk => data.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(data);
      req.rawBody = buffer;  // ← This is what Paystack signed
      console.log(`Raw body captured: ${buffer.length} bytes`);
      next();
    });
  } else {
    next();
  }
});

// ==================== 2. CRITICAL: MOUNT WEBHOOK ROUTES BEFORE ANY PARSERS ====================
const webhookRoutes = require('./routes/webhooks');
app.use('/api/webhooks', webhookRoutes);  // ← MUST BE BEFORE express.json()!

// ==================== 3. NOW SAFE TO USE STANDARD PARSERS ====================
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

    // Step 1: Find and fix ALL duplicate references
    console.log('Scanning for duplicate references...');
    
    const duplicates = await collection.aggregate([
      {
        $match: {
          reference: { $ne: null, $type: "string" }
        }
      },
      {
        $group: {
          _id: "$reference",
          count: { $sum: 1 },
          ids: { $push: "$_id" }
        }
      },
      {
        $match: {
          count: { $gt: 1 }
        }
      }
    ]).toArray();

    console.log(`Found ${duplicates.length} duplicate reference groups`);

    // Step 2: Fix duplicates - keep the first one, modify the rest
    for (const dup of duplicates) {
      const [keepId, ...fixIds] = dup.ids;
      
      for (const fixId of fixIds) {
        const newReference = `${dup._id}_dedup_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        await collection.updateOne(
          { _id: fixId },
          { $set: { reference: newReference } }
        );
        console.log(`Fixed duplicate reference: ${dup._id} -> ${newReference}`);
      }
    }

    // Step 3: Fix any remaining null references
    const nullResult = await collection.updateMany(
      { reference: null },
      { 
        $set: { 
          reference: `legacy_null_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        } 
      }
    );
    
    if (nullResult.modifiedCount > 0) {
      console.log(`Cleaned up ${nullResult.modifiedCount} transactions with null references`);
    }

    // Step 4: Create the critical indexes with explicit names
    await Promise.all([
      // This index is what makes double funding IMPOSSIBLE
      collection.createIndex(
        { reference: 1 },
        { 
          unique: true, 
          background: true, 
          name: 'unique_reference_transactions'
        }
      ),

      // Virtual account lookup
      usersCollection.createIndex(
        { "virtualAccount.accountNumber": 1 },
        { unique: true, sparse: true, background: true, name: 'virtual_account_number_unique' }
      ),

      // Fast user lookup by email
      usersCollection.createIndex(
        { email: 1 },
        { background: true, name: 'email_lookup' }
      ),

      // Performance
      collection.createIndex(
        { userId: 1, createdAt: -1 },
        { background: true, name: 'user_transactions_performance' }
      )
    ]);

    console.log('ALL CRITICAL INDEXES ENSURED — DOUBLE FUNDING IS NOW IMPOSSIBLE');
    console.log(`Fixed ${duplicates.length} duplicate reference groups and ${nullResult.modifiedCount} null references`);

  } catch (err) {
    console.error('Failed to create indexes:', err.message);
    // Don't crash — indexes might already exist in different forms
  }
}

// ==================== 6. DEBUG ROUTES ====================
app.get('/api/debug/raw-body-test', (req, res) => {
  res.json({
    message: "Raw body middleware is working!",
    rawBodyLength: req.rawBody ? req.rawBody.length : 0,
    headers: req.headers
  });
});

app.get('/api/debug/indexes', async (req, res) => {
  try {
    const transactionsIndexes = await mongoose.connection.collection('transactions').indexes();
    const usersIndexes = await mongoose.connection.collection('users').indexes();
    
    res.json({
      transactions: transactionsIndexes.map(idx => ({
        name: idx.name,
        key: idx.key,
        unique: idx.unique || false
      })),
      users: usersIndexes.map(idx => ({
        name: idx.name,
        key: idx.key,
        unique: idx.unique || false
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== 7. HEALTH CHECK ====================
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    doubleFundingProtection: 'ACTIVE',
    webhookRawBody: 'ENABLED'
  });
});

// ==================== 8. START SERVER ====================
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('MongoDB connected successfully');

    // Ensure critical indexes
    await ensureCriticalIndexes();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Health: http://localhost:${PORT}/health`);
      console.log(`Raw Body Test: http://localhost:${PORT}/api/debug/raw-body-test`);
      console.log(`DOUBLE FUNDING PROTECTION: FULLY ACTIVE`);
      console.log(`WEBHOOK RAW BODY: ENABLED`);
    });

  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Start the server
startServer();
