// models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    transactionPin: { 
      type: String 
    },
    password: {
      type: String,
      required: true,
    },
    walletBalance: {
      type: Number,
      default: 0.0,
    },
    commissionBalance: {
      type: Number,
      default: 0.0,
    },
    isAdmin: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    
    // === NEW FIELDS TO ADD ===
    
    // Referral system fields
    referralCode: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    referrerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    referralCount: {
      type: Number,
      default: 0,
    },
    totalReferralEarnings: {
      type: Number,
      default: 0.0,
    },
    
    // Authentication fields
    refreshToken: {
      type: String,
      default: null,
    },
    resetPasswordToken: {
      type: String,
      default: null,
    },
    resetPasswordExpire: {
      type: Date,
      default: null,
    },
    
    // Security fields
    failedPinAttempts: {
      type: Number,
      default: 0,
    },
    pinLockedUntil: {
      type: Date,
      default: null,
    },
    biometricEnabled: {
      type: Boolean,
      default: false,
    },
    biometricKey: {
      type: String,
      default: null,
    },
    biometricCredentialId: {
      type: String,
      default: null,
    },
    
    // Profile fields
    profileImage: {
      type: String,
      default: null,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    
    // First transaction tracking
    isFirstTransaction: {
      type: Boolean,
      default: true,
    },
    hasReceivedFirstTransactionBonus: {
      type: Boolean,
      default: false,
    },
    
    // Virtual Account fields
    virtualAccount: {
      assigned: { 
        type: Boolean, 
        default: false 
      },
      bankName: { 
        type: String, 
        default: '' 
      },
      accountNumber: { 
        type: String, 
        unique: true, 
        sparse: true 
      },
      accountName: { 
        type: String, 
        default: '' 
      },
      reference: { 
        type: String, 
        unique: true, 
        sparse: true 
      },
    },
  },
  {
    timestamps: true,
  }
);


// Hash transaction PIN before saving if modified
userSchema.pre('save', async function (next) {
  if (this.isModified('transactionPin') && this.transactionPin) {
    console.log(`DEBUG (User Model Pre-Save): Hashing transaction PIN for user ${this.email}`);
    const salt = await bcrypt.genSalt(10);
    this.transactionPin = await bcrypt.hash(this.transactionPin, salt);
  }
  next();
});

// Method to compare entered password with hashed password
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Method to compare transaction PIN
userSchema.methods.matchTransactionPin = async function (enteredPin) {
  if (!this.transactionPin) {
    return false;
  }
  return await bcrypt.compare(enteredPin, this.transactionPin);
};

// Method to check if PIN is locked
userSchema.methods.isPinLocked = function () {
  return this.pinLockedUntil && this.pinLockedUntil > new Date();
};

// Method to get remaining lock time in minutes
userSchema.methods.getRemainingLockTime = function () {
  if (!this.pinLockedUntil) return 0;
  const now = new Date();
  const diff = this.pinLockedUntil - now;
  return Math.ceil(diff / (1000 * 60)); // Convert to minutes
};

// Method to increment failed PIN attempts
userSchema.methods.incrementFailedPinAttempts = function () {
  this.failedPinAttempts += 1;
  
  // Lock account after 3 failed attempts for 15 minutes
  if (this.failedPinAttempts >= 3) {
    this.pinLockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
  }
  
  return this.save();
};

// Method to reset failed PIN attempts (on successful PIN entry)
userSchema.methods.resetFailedPinAttempts = function () {
  this.failedPinAttempts = 0;
  this.pinLockedUntil = null;
  return this.save();
};

// Static method to find user by referral code
userSchema.statics.findByReferralCode = function (referralCode) {
  return this.findOne({ referralCode: referralCode.toUpperCase() });
};

// Virtual for formatted wallet balance
userSchema.virtual('formattedWalletBalance').get(function () {
  return `₦${this.walletBalance.toFixed(2)}`;
});

// Virtual for formatted commission balance
userSchema.virtual('formattedCommissionBalance').get(function () {
  return `₦${this.commissionBalance.toFixed(2)}`;
});

// Index for better performance
userSchema.index({ email: 1 });
userSchema.index({ phone: 1 });
userSchema.index({ referralCode: 1 });
userSchema.index({ referrerId: 1 });
userSchema.index({ 'virtualAccount.accountNumber': 1 });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
