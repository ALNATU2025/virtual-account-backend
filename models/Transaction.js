// models/Transaction.js
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },

    type: {
        type: String,
        enum: [
            'Transfer-Sent', 
            'Transfer-Received', 
            'Airtime', 
            'Data', 
            'CableTV', 
            'CashWithdraw', 
            'FundWallet', 
            'wallet_funding',
            'virtual_account_topup',
            'virtual_account_deposit',
            'credit',
            'debit'
        ],
        required: true,
        index: true
    },

    amount: {
        type: Number,
        required: true
    },

    status: {
        type: String,
        enum: ['Successful', 'Pending', 'Failed', 'Completed'],
        set: (v) => {
            if (!v) return 'Pending';
            const n = v.toString().trim().toLowerCase();

            if (['successful', 'success'].includes(n)) return 'Successful';
            if (['completed', 'complete'].includes(n)) return 'Completed';
            if (['failed', 'fail'].includes(n)) return 'Failed';

            return n.charAt(0).toUpperCase() + n.slice(1);
        },
        default: 'Pending',
        index: true
    },

    transactionId: {
        type: String,
        unique: true,
        sparse: true,
        default: null
    },

    reference: {
        type: String,
        unique: true,
        sparse: true,
        index: true
    },

    description: {
        type: String,
        default: ''
    },

    balanceBefore: {
        type: Number,
        default: 0
    },

    balanceAfter: {
        type: Number,
        default: 0
    },

    details: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }

}, { timestamps: true });


// 💡 Generate transactionId ONLY if missing
transactionSchema.pre('save', function(next) {
    if (!this.transactionId) {
        this.transactionId = `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`.toUpperCase();
    }
    next();
});

// Performance indexes
transactionSchema.index({ userId: 1, createdAt: -1 });

module.exports =
  mongoose.models.Transaction ||
  mongoose.model('Transaction', transactionSchema);
