const mongoose = require('mongoose');

const failedSyncSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true
  },
  reference: {
    type: String,
    required: true,
    index: true
  },
  error: {
    type: String,
    required: true
  },
  retryCount: {
    type: Number,
    default: 0
  },
  lastAttempt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('FailedSync', failedSyncSchema);
