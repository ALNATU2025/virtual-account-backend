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

// Import routes
const virtualAccountRoutes = require('./routes/virtualAccount');

// Use routes
app.use('/api/virtual-account', virtualAccountRoutes);

// --- 🩺 Health Check Endpoint ---
app.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'Virtual Account Backend is running',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// --- Default Root Route ---
app.get('/', (req, res) => {
    res.send('🚀 Virtual Account Backend is running successfully');
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
