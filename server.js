// server.js - UPDATED VERSION
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected successfully'))
.catch(err => console.error('❌ MongoDB connection failed:', err));

// Import and use routes
const virtualAccountRoutes = require('./routes/virtualAccount');
const webhookRoutes = require('./routes/webhooks');
const paymentRoutes = require('./routes/payments');

app.use('/api/virtual-accounts', virtualAccountRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/payments', paymentRoutes);

console.log('✅ All routes mounted successfully');

// Health check
app.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'Virtual Account Backend is running',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
    });
});

// Root route
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: '🚀 Virtual Account Backend is running successfully',
        version: '1.0.0',
        endpoints: [
            'GET /health',
            'POST /api/virtual-accounts/create-instant-account',
            'GET /api/virtual-accounts/:userId',
            'GET /api/virtual-accounts/health/status',
            'POST /api/webhooks/paystack',
            'POST /api/payments/verify',
            'GET /api/payments/verify', // ✅ ADDED GET ENDPOINT
            'POST /api/payments/initialize',
            'POST /api/payments/sync-success',
            'GET /api/wallet/balance/:userId', // ✅ ADDED
            'POST /api/wallet/top-up' // ✅ ADDED
        ]
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Available at: https://virtual-account-backend.onrender.com`);
});
