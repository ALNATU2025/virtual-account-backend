const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// SIMPLIFIED CORS Configuration - Allow all origins in development
const corsOptions = {
  origin: function (origin, callback) {
    // In development, allow ALL origins
    if (process.env.NODE_ENV === 'development') {
      console.log('🌐 DEVELOPMENT: Allowing origin:', origin);
      return callback(null, true);
    }
    
    // In production, use your allowed origins
    const allowedOrigins = [
      'https://virtual-account-backend.onrender.com',
      'https://your-app.com', // Your production domain
      'https://www.your-app.com',
    ];
    
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('🚫 PRODUCTION: CORS blocked for origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
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
  credentials: true,
  maxAge: 86400,
  optionsSuccessStatus: 204
};

// Apply CORS middleware
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Other middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Import routes
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

// Add the PayStack proxy endpoint
app.post('/api/payments/verify-paystack', async (req, res) => {
  try {
    const { reference } = req.body;
    
    if (!reference) {
      return res.status(400).json({
        success: false,
        message: 'Reference is required'
      });
    }

    console.log('🔍 Proxy: Verifying PayStack transaction:', reference);

    // Call PayStack API from backend
    const paystackResponse = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await paystackResponse.json();
    
    console.log('📡 PayStack proxy response:', data.status);

    if (data.status && data.data && data.data.status === 'success') {
      res.json({
        success: true,
        status: data.data.status,
        amount: data.data.amount / 100,
        reference: data.data.reference,
        paidAt: data.data.paid_at,
        message: 'Payment verified successfully via proxy',
        source: 'paystack_proxy'
      });
    } else {
      res.json({
        success: false,
        message: data.message || 'Payment verification failed',
        status: data.data?.status || 'unknown'
      });
    }

  } catch (error) {
    console.error('❌ PayStack proxy error:', error);
    res.status(500).json({
      success: false,
      message: 'Proxy service temporarily unavailable',
      error: process.env.NODE_ENV === 'production' ? null : error.message
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
    cors: 'Enabled - All origins allowed in development'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Virtual Account Backend is running successfully',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    webhook_url: 'https://virtual-account-backend.onrender.com/api/webhooks/paystack',
    paystack_proxy: 'https://virtual-account-backend.onrender.com/api/payments/verify-paystack'
  });
});

// Handle 404 errors
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`
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
    console.log(`🌐 CORS: All origins allowed in development`);
    console.log(`🔗 PayStack Proxy: https://virtual-account-backend.onrender.com/api/payments/verify-paystack`);
  });
})
.catch(err => {
  console.error('❌ MongoDB connection failed:', err);
  process.exit(1);
});
