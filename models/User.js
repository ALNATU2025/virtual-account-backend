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
    
    // === KYC / CASHWYRE DEDICATED ACCOUNT FIELDS ===
    
    // KYC Information
    bvn: {
      type: String,
      default: null,
      trim: true,
    },
    nin: {
      type: String,
      default: null,
      trim: true,
    },
    kycVerified: {
      type: Boolean,
      default: false,
    },
    kycSubmittedAt: {
      type: Date,
      default: null,
    },
    kycApprovedAt: {
      type: Date,
      default: null,
    },
    
    // Cashwyre Reserve Account Reference
    accountReference: {
      type: String,
      default: null,
      unique: true,
      sparse: true,
      trim: true,
    },
    
    // Additional KYC Details (optional fields)
    dateOfBirth: {
      type: Date,
      default: null,
    },
    gender: {
      type: String,
      enum: ['Male', 'Female', 'Other', null],
      default: null,
    },
    address: {
      type: String,
      default: null,
    },
    city: {
      type: String,
      default: null,
    },
    state: {
      type: String,
      default: null,
    },
    country: {
      type: String,
      default: 'Nigeria',
    },
    
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
    resetPasswordOTP: {
      type: String,
      default: null,
    },
    resetPasswordOTPExpire: {
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
    
    // Virtual Account fields (for Cashwyre Reserve Account)
    virtualAccount: {
      assigned: { 
        type: Boolean, 
        default: false 
      },
      bankName: { 
        type: String, 
        default: null 
      },
      accountNumber: { 
        type: String, 
        unique: true, 
        sparse: true,
        default: null
      },
      accountName: { 
        type: String, 
        default: null 
      },
      reference: { 
        type: String, 
        unique: true, 
        sparse: true,
        default: null
      },
      bankCode: {
        type: String,
        default: null,
      },
      currency: {
        type: String,
        default: 'NGN',
      },
      status: {
        type: String,
        enum: ['ACTIVE', 'INACTIVE', 'PENDING', null],
        default: null,
      },
      createdOn: {
        type: Date,
        default: null,
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

// ============================================================
// KYC / DEDICATED ACCOUNT METHODS
// ============================================================

// Check if user has completed KYC
userSchema.methods.hasCompletedKYC = function () {
  return this.kycVerified === true && 
         this.bvn !== null && 
         this.bvn !== '' &&
         this.nin !== null && 
         this.nin !== '';
};

// Check if user has a dedicated account
userSchema.methods.hasDedicatedAccount = function () {
  return this.virtualAccount.assigned === true && 
         this.virtualAccount.accountNumber !== null &&
         this.virtualAccount.accountNumber !== '';
};

// Get dedicated account details
userSchema.methods.getDedicatedAccount = function () {
  if (!this.hasDedicatedAccount()) {
    return null;
  }
  return {
    accountNumber: this.virtualAccount.accountNumber,
    accountName: this.virtualAccount.accountName || this.fullName,
    bankName: this.virtualAccount.bankName || 'Moniepoint Microfinance Bank',
    bankCode: this.virtualAccount.bankCode || '50515',
    currency: this.virtualAccount.currency || 'NGN',
    status: this.virtualAccount.status || 'ACTIVE',
    assigned: this.virtualAccount.assigned,
    reference: this.virtualAccount.reference,
    createdOn: this.virtualAccount.createdOn,
  };
};

// Assign a dedicated account to user
userSchema.methods.assignDedicatedAccount = function (accountData) {
  this.virtualAccount.assigned = true;
  this.virtualAccount.accountNumber = accountData.accountNumber;
  this.virtualAccount.accountName = accountData.accountName || this.fullName;
  this.virtualAccount.bankName = accountData.bankName || 'Moniepoint Microfinance Bank';
  this.virtualAccount.bankCode = accountData.bankCode || '50515';
  this.virtualAccount.currency = accountData.currency || 'NGN';
  this.virtualAccount.status = accountData.status || 'ACTIVE';
  this.virtualAccount.reference = accountData.accountReference || this.accountReference;
  this.virtualAccount.createdOn = accountData.createdOn || new Date();
  this.accountReference = accountData.accountReference || this.accountReference;
  
  return this.save();
};

// Update KYC information
userSchema.methods.updateKYC = function (kycData) {
  if (kycData.bvn) this.bvn = kycData.bvn;
  if (kycData.nin) this.nin = kycData.nin;
  if (kycData.dateOfBirth) this.dateOfBirth = kycData.dateOfBirth;
  if (kycData.gender) this.gender = kycData.gender;
  if (kycData.address) this.address = kycData.address;
  if (kycData.city) this.city = kycData.city;
  if (kycData.state) this.state = kycData.state;
  if (kycData.country) this.country = kycData.country;
  
  this.kycVerified = true;
  this.kycSubmittedAt = new Date();
  this.kycApprovedAt = new Date();
  
  return this.save();
};

// ============================================================
// VIRTUAL FIELDS
// ============================================================

// Virtual for formatted wallet balance
userSchema.virtual('formattedWalletBalance').get(function () {
  return `₦${this.walletBalance.toFixed(2)}`;
});

// Virtual for formatted commission balance
userSchema.virtual('formattedCommissionBalance').get(function () {
  return `₦${this.commissionBalance.toFixed(2)}`;
});

// Virtual for KYC status
userSchema.virtual('kycStatus').get(function () {
  if (this.kycVerified) return 'VERIFIED';
  if (this.bvn || this.nin) return 'PENDING';
  return 'NOT_STARTED';
});

// Virtual for account status
userSchema.virtual('accountStatus').get(function () {
  if (this.virtualAccount.assigned && this.virtualAccount.status === 'ACTIVE') {
    return 'ACTIVE';
  }
  if (this.virtualAccount.assigned) {
    return 'INACTIVE';
  }
  return 'NOT_ASSIGNED';
});

// ============================================================
// INDEXES
// ============================================================

userSchema.index({ email: 1 });
userSchema.index({ phone: 1 });
userSchema.index({ referralCode: 1 });
userSchema.index({ referrerId: 1 });
userSchema.index({ 'virtualAccount.accountNumber': 1 });
userSchema.index({ accountReference: 1 });
userSchema.index({ bvn: 1 });
userSchema.index({ nin: 1 });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
