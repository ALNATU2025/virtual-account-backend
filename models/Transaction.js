const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        index: true
    },
    type: {
        type: String,
        required: true,
        enum: ['wallet_funding', 'transfer', 'payment', 'withdrawal']
    },
    amount: {
        type: Number,
        required: true
    },
    reference: {
        type: String,
        required: true,
        unique: true
    },
    status: {
        type: String,
        required: true,
        enum: ['pending', 'success', 'failed', 'cancelled'],
        default: 'pending'
    },
    gateway: {
        type: String,
        enum: ['paystack', 'flutterwave', 'monnify', 'bank_transfer']
    },
    gatewayResponse: {
        type: mongoose.Schema.Types.Mixed
    },
    description: {
        type: String
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed
    }
}, {
    timestamps: true
});

// Index for better query performance
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ reference: 1 });
transactionSchema.index({ status: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
