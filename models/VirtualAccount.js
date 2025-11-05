// models/VirtualAccount.js - COMPLETE FIXED VERSION
const mongoose = require('mongoose'); // ✅ ADD THIS MISSING LINE

const virtualAccountSchema = new mongoose.Schema({
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
        required: false // ✅ TEMPORARY: Set to false to fix existing users
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('VirtualAccount', virtualAccountSchema);
