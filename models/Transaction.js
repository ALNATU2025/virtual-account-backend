// virtual-account-backend/models/Transaction.js - UPDATED
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
        enum: [
            'wallet_funding', 
            'transfer', 
            'payment', 
            'withdrawal',
            'virtual_account_deposit', // ADDED
            'balance_adjustment'       // ADDED
        ]
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
        enum: [
            'pending', 
            'success', 
            'failed', 
            'cancelled',
            'completed' // ADDED
        ],
        default: 'pending'
    },
    gateway: {
        type: String,
        enum: [
            'paystack', 
            'flutterwave', 
            'monnify', 
            'bank_transfer',
            'paystack_virtual_account' // ADDED
        ]
    },
    gatewayResponse: {
        type: mongoose.Schema.Types.Mixed
    },
    description: {
        type: String
    },

    // KEEP ONLY THESE — ideal for wallet updates
    balanceBefore: {
        type: Number
    },
    balanceAfter: {
        type: Number
    },

    metadata: {
        type: mongoose.Schema.Types.Mixed
    }
}, {
    timestamps: true
});

// Indexes
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ reference: 1 });
transactionSchema.index({ status: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
