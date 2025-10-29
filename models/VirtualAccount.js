const mongoose = require('mongoose');

const virtualAccountSchema = new mongoose.Schema({
    // ✅ CHANGE: Use String instead of ObjectId
    userId: {
        type: String,
        required: true,
        unique: true
    },
    accountNumber: {
        type: String,
        required: true,
        unique: true
    },
    accountName: {
        type: String,
        required: true
    },
    bankName: {
        type: String,
        required: true
    },
    bankCode: {
        type: String,
        required: true
    },
    customerCode: {
        type: String,
        required: true
    },
    assigned: {
        type: Boolean,
        default: true
    },
    active: {
        type: Boolean,
        default: true
    },
    paystackReference: {
        type: String,
        required: true
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('VirtualAccount', virtualAccountSchema);
