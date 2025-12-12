const mongoose = require('mongoose');

const metadataSchema = new mongoose.Schema({
    phone: { type: String, default: '' },
    smartcardNumber: { type: String, default: '' },
    billersCode: { type: String, default: '' },
    variation_code: { type: String, default: '' },
    packageName: { type: String, default: '' },
    serviceID: { type: String, default: '' },
    selectedPackage: { type: String, default: '' },
    meterNumber: { type: String, default: '' },
    provider: { type: String, default: '' },
    type: { type: String, default: '' },
    token: { type: String, default: '' },
    customerName: { type: String, default: '' },
    customerAddress: { type: String, default: '' },
    exchangeReference: { type: String, default: '' },
    vtpassResponse: { type: mongoose.Schema.Types.Mixed, default: {} },
    
    // Paystack specific data
    paystackData: { type: mongoose.Schema.Types.Mixed, default: {} },
    
    // CORRECT: Array type for verificationHistory
    verificationHistory: [{
        method: { type: String, enum: ['polling', 'webhook', 'callback', 'manual'] },
        timestamp: { type: Date, default: Date.now },
        status: { type: String },
        response: { type: mongoose.Schema.Types.Mixed }
    }]
}, { _id: false });

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
        'Airtime Purchase',
        'Data Purchase',
        'Cable TV Subscription',
        'Electricity Payment',
        'Education Payment',
        'Insurance Purchase',
        'Wallet Funding',
        'Transfer Sent',
        'Transfer Received',
        'Commission Credit',
        'Commission Withdrawal',
        'debit',
        'credit',
        'wallet_funding',
        'virtual_account_topup'   // ✅ Added correctly
    ],
    required: true
},

    amount: { type: Number, required: true, min: 0 },
    status: {
        type: String,
        enum: ['Successful', 'Pending', 'Failed', 'Processing'],
        default: 'Pending'
    },
    transactionId: { type: String, unique: true, sparse: true },
    reference: { type: String, unique: true, sparse: true, index: true },
    description: { type: String, required: true },
    balanceBefore: { type: Number, default: 0 },
    balanceAfter: { type: Number, default: 0 },
    metadata: metadataSchema,
    isCommission: { type: Boolean, default: false, index: true },
    service: { type: String, default: '', index: true },
    authenticationMethod: {
        type: String,
        enum: ['pin', 'biometric', 'none', 'paystack', 'manual'],
        default: 'none'
    },
    
    // NEW FIELDS FOR FAILED TRANSACTION FIX
    gateway: { type: String, default: 'paystack' },
    gatewayResponse: { type: mongoose.Schema.Types.Mixed },
    gatewayReference: { type: String, index: true },
    retryCount: { type: Number, default: 0, max: 3 },
    lastVerifiedAt: Date,
    verificationAttempts: { type: Number, default: 0 },
    failureReason: String,
    canRetry: { type: Boolean, default: false },
    nextRetryAt: Date
}, {
    timestamps: true,
    versionKey: false
});

// Auto generate transactionId
transactionSchema.pre('save', function(next) {
    if (!this.transactionId) {
        this.transactionId = `TXN${Date.now()}${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    }
    next();
});

// Virtual: Phone number from metadata
transactionSchema.virtual('phoneNumber').get(function() {
    return this.metadata?.phone || this.metadata?.billersCode || null;
});

// NIGERIA TIMEZONE (UTC+1) — FINAL FIX
transactionSchema.virtual('nigeriaTime').get(function() {
    if (!this.createdAt) return null;
    return new Date(this.createdAt.getTime() + 60 * 60 * 1000);
});

transactionSchema.virtual('formattedNigeriaTime').get(function() {
    return this.nigeriaTime 
      ? this.nigeriaTime.toLocaleString('en-NG', {
          year: 'numeric',
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        })
      : '';
});

// FIX: Convert createdAt to Nigeria time in ALL API responses
transactionSchema.set('toJSON', {
    virtuals: true,
    transform: (doc, ret) => {
        if (ret.createdAt) {
            ret.createdAt = new Date(ret.createdAt.getTime() + 60 * 60 * 1000);
        }
        if (ret.updatedAt) {
            ret.updatedAt = new Date(ret.updatedAt.getTime() + 60 * 60 * 1000);
        }
        return ret;
    }
});

transactionSchema.set('toObject', { virtuals: true });

// Indexes
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ userId: 1, isCommission: 1 });
transactionSchema.index({ reference: 1 });
transactionSchema.index({ status: 1, createdAt: -1 });
transactionSchema.index({ gatewayReference: 1 }); // NEW INDEX

module.exports = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);
