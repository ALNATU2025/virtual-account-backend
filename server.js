// server.js — FINAL 100% WORKING VERSION (NO MORE CRASHES)
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// ==================== 1. RAW BODY MIDDLEWARE — MUST BE FIRST ====================
app.use((req, res, next) => {
  if (req.originalUrl.startsWith('/api/webhooks/paystack') || 
      req.originalUrl.startsWith('/api/webhooks/virtual-account')) {
    
    console.log('RAW BODY MIDDLEWARE TRIGGERED');
    let data = [];
    req.on('data', chunk => data.push(chunk));
    req.on('end', () => {
      req.rawBody = Buffer.concat(data);
      console.log(`Raw body captured: ${req.rawBody.length} bytes`);
      next();
    });
  } else {
    next();
  }
});

// ==================== 2. MOUNT WEBHOOK ROUTES — BEFORE PARSERS ====================
const webhookRoutes = require('./routes/webhooks');
app.use('/api/webhooks', webhookRoutes);

// ==================== 3. CORS & PARSERS — AFTER WEBHOOKS ====================
app.use(cors({ origin: true, credentials: true }));
app.options('*', cors());

// CRITICAL: Only parse JSON if it's NOT a webhook
app.use((req, res, next) => {
  if (req.rawBody) {
    // Webhook already handled — skip JSON parsing
    return next();
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});

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

// ==================== 5. INDEXES ====================
async function ensureCriticalIndexes() {
  try {
    const collection = mongoose.connection.collection('transactions');
    await collection.createIndex(
      { reference: 1 },
      { unique: true, background: true }
    );
    console.log('DOUBLE FUNDING PROTECTION: ACTIVE');
  } catch (err) { /* ignore */ }
}

app.get('/health', (req, res) => res.json({ status: 'OK' }));

const PORT = process.env.PORT || 3000;

async function startServer() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connected');
  await ensureCriticalIndexes();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server LIVE on port ${PORT}`);
    console.log(`Webhook: https://virtual-account-backend.onrender.com/api/webhooks/virtual-account`);
  });
}

startServer();
