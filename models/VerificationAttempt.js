const mongoose = require('mongoose');

const verificationAttemptSchema = new mongoose.Schema({
  reference: {
    type: String,
    required: true,
    index: true
  },
  error: {
    type: String,
    required: true
  },
  attemptedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('VerificationAttempt', verificationAttemptSchema);
