const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    unique: true
  },
  balance: {
    type: Number,
    default: 0.0
  },
  currency: {
    type: String,
    default: 'NGN'
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Wallet', walletSchema);
