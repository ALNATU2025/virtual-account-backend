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
            'virtual_account_deposit', // ADD THIS
            'balance_adjustment' // ADD THIS
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
            'completed' // ADD THIS to match your code
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
            'paystack_virtual_account' // ADD THIS
        ]
    },
    gatewayResponse: {
        type: mongoose.Schema.Types.Mixed
    },
    description: {
        type: String
    },
    // ADD THESE OPTIONAL BALANCE FIELDS
    balanceBefore: {
        type: Number,
        required: false
    },
    balanceAfter: {
        type: Number,
        required: false
    },
    previousBalance: {
        type: Number,
        required: false
    },
    newBalance: {
        type: Number,
        required: false
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
