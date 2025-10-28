const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

// Initialize Express app
const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
    .then(() => console.log('✅ MongoDB connected successfully'))
    .catch(err => console.error('❌ MongoDB connection failed:', err));

// Import routes - FIXED: Check what's actually exported from the routes file
let virtualAccountRoutes;
try {
    // Try different export patterns
    const routesModule = require('./routes/virtualAccount');
    
    // Check if it's the router object directly
    if (routesModule && typeof routesModule === 'function') {
        virtualAccountRoutes = routesModule;
    } 
    // Check if it's exported as module.exports = router
    else if (routesModule && routesModule.router) {
        virtualAccountRoutes = routesModule.router;
    }
    // Check if it's exported with a specific property
    else if (routesModule && routesModule.default) {
        virtualAccountRoutes = routesModule.default;
    }
    // If none of the above, assume it's the router directly
    else {
        virtualAccountRoutes = routesModule;
    }
    
    console.log('✅ Virtual account routes loaded successfully');
} catch (error) {
    console.error('❌ Failed to load virtual account routes:', error);
    // Create a basic router as fallback
    virtualAccountRoutes = express.Router();
    virtualAccountRoutes.get('/', (req, res) => {
        res.json({ message: 'Virtual account routes are temporarily unavailable' });
    });
}

// Use routes - FIXED: Ensure we're using a valid middleware function
if (virtualAccountRoutes && typeof virtualAccountRoutes === 'function') {
    app.use('/api/virtual-accounts', virtualAccountRoutes);
    console.log('✅ Virtual account routes mounted at /api/virtual-accounts');
} else {
    console.error('❌ virtualAccountRoutes is not a valid middleware function');
    // Fallback route
    app.use('/api/virtual-accounts', express.Router().get('/', (req, res) => {
        res.json({ error: 'Virtual account service configuration error' });
    }));
}

// --- 🩺 Health Check Endpoint ---
app.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'Virtual Account Backend is running',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
    });
});

// --- Default Root Route ---
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: '🚀 Virtual Account Backend is running successfully',
        version: '1.0.0',
        endpoints: [
            '/health',
            '/api/virtual-accounts'
        ]
    });
});

// --- 404 Error Handler ---
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found',
        path: req.originalUrl
    });
});

// --- Global Error Handler ---
app.use((err, req, res, next) => {
    console.error('🚨 Server error:', err);
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'production' ? {} : err.message
    });
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`🔗 API Base: http://localhost:${PORT}/api/virtual-accounts`);
});
