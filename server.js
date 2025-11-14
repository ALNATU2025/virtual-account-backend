const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware - IMPORTANT: Order matters!
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Import routes
const virtualAccountRoutes = require('./routes/virtualAccount');
const webhookRoutes = require('./routes/webhooks');
const paymentRoutes = require('./routes/payments');
const walletRoutes = require('./routes/wallet');

// Mount routes
app.use('/api/virtual-accounts', virtualAccountRoutes);
app.use('/api/webhooks', webhookRoutes);  // This should come before other middleware that might interfere
app.use('/api/payments', paymentRoutes);
app.use('/api/wallet', walletRoutes);

console.log('✅ All routes mounted successfully');

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Virtual Account Backend is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    endpoints: [
      'GET /health',
      'GET /api/webhooks/paystack - Test webhook',
      'POST /api/webhooks/paystack - PayStack webhooks',
      'GET /api/payments/verify - Verify payment',
      'POST /api/payments/initialize - Initialize payment'
    ]
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Virtual Account Backend is running successfully',
    version: '1.0.0',
    webhook_url: 'https://virtual-account-backend.onrender.com/api/webhooks/paystack',
    health_check: 'https://virtual-account-backend.onrender.com/health'
  });
});

// Handle 404 errors
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
    available_endpoints: [
      'GET /health',
      'GET /api/webhooks/paystack',
      'POST /api/webhooks/paystack',
      'GET /api/payments/verify',
      'POST /api/payments/initialize'
    ]
  });
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
    console.log(`🔗 Webhook URL: https://virtual-account-backend.onrender.com/api/webhooks/paystack`);
    console.log(`❤️ Health check: https://virtual-account-backend.onrender.com/health`);
  });
})
.catch(err => {
  console.error('❌ MongoDB connection failed:', err);
  process.exit(1);
});
