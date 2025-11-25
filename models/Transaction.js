// models/Transaction.js
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
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
            'virtual_account_topup',      // ← NEW: For automatic deposits
            'virtual_account_deposit',    // ← Optional extra name
            'credit',                     // ← For sync compatibility
            'debit'
        ],
        required: true,
    },
    amount: {
        type: Number,
        required: true,
    },
    status: {
    type: String,
    enum: ['Successful', 'Pending', 'Failed', 'Completed'],  // ← 'Completed' added to enum
    set: (v) => {
      if (!v) return 'Pending';
      const normalized = v.toString().trim().toLowerCase();
      if (normalized === 'successful' || normalized === 'success') {
        return 'Successful';
      }
      if (normalized === 'completed' || normalized === 'complete') {
        return 'Completed';
      }
      // Capitalize first letter for any other value
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    },
    default: 'Pending',
},
    transactionId: {
        type: String,
        unique: true,
        sparse: true,        // ← THIS ALLOWS null/undefined while keeping uniqueness
        default: null        // ← No longer required
        // You can auto-generate it in the controller if you want
    },
    reference: {             // ← ADD THIS: PayStack reference (very useful!)
        type: String,
        unique: true,
        sparse: true
    },
    description: {           // ← Optional but nice to have
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
    },
}, { timestamps: true });

// Optional: Auto-generate transactionId if not provided
transactionSchema.pre('save', function(next) {
    if (!this.transactionId) {
        this.transactionId = `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`.toUpperCase();
    }
    if (this.reference && !this.transactionId) {
        this.transactionId = this.reference; // fallback
    }
    next();
});

module.exports = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);
