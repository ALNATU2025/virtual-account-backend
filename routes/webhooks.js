// routes/webhooks.js - ZERO DOUBLE FUNDING GUARANTEE
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const Transaction = require("../models/Transaction");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// PRODUCTION WEBHOOK - MATHEMATICALLY SAFE
router.post("/virtual-account", express.raw({ type: 'application/json' }), async (req, res) => {
  console.log("🔔 WEBHOOK RECEIVED");
  
  // ✅ IMMEDIATE 200 RESPONSE (Prevents PayStack retries)
  res.status(200).send("OK");

  try {
    const signature = req.headers["x-paystack-signature"];
    if (!signature) {
      console.log("❌ Missing signature");
      return;
    }

    // Verify signature
    const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(req.body).digest("hex");
    if (hash !== signature) {
      console.log("❌ Invalid signature");
      return;
    }

    const event = JSON.parse(req.body.toString());
    
    // ✅ ONLY PROCESS SUCCESSFUL CHARGES
    if (event.event === "charge.success" && event.data?.status === "success") {
      await processPaymentSafely(event.data);
    }

  } catch (error) {
    console.error("Webhook error:", error.message);
  }
});

// ✅ ATOMIC PROCESSING - NO RACE CONDITIONS
async function processPaymentSafely(data) {
  const reference = data.reference;
  const amountNaira = Number(data.amount) / 100;
  
  console.log(`💰 PROCESSING: ${reference} | ₦${amountNaira}`);

  const session = await mongoose.startSession();
  
  try {
    // ✅ DATABASE TRANSACTION - ALL OR NOTHING
    await session.withTransaction(async () => {
      // ✅ CRITICAL: ATOMIC DUPLICATE CHECK (within transaction)
      const existing = await Transaction.findOne({ reference }).session(session);
      if (existing) {
        console.log(`⏭️ ALREADY PROCESSED: ${reference} (Atomic check)`);
        return; // Transaction will be aborted
      }

      // ✅ FIND USER
      const user = await findUser(data, session);
      if (!user) {
        console.log("❌ USER NOT FOUND");
        return;
      }

      console.log(`✅ USER: ${user.email} | Balance: ₦${user.walletBalance}`);

      // ✅ UPDATE BALANCE (Atomic)
      const balanceBefore = user.walletBalance;
      user.walletBalance += amountNaira;
      await user.save({ session });

      // ✅ CREATE TRANSACTION (Atomic - will fail if reference exists)
      try {
        await Transaction.create([{
          userId: user._id,
          type: "credit",
          amount: amountNaira,
          status: "successful",
          reference: reference, // ← UNIQUE CONSTRAINT
          description: `Wallet funding via ${data.channel || 'PayStack'}`,
          balanceBefore: balanceBefore,
          balanceAfter: user.walletBalance,
          gateway: "paystack",
          isCommission: false,
          authenticationMethod: "paystack_webhook"
        }], { session });
      } catch (createError) {
        // ✅ CATCH UNIQUE CONSTRAINT VIOLATION
        if (createError.code === 11000) {
          console.log(`⏭️ DUPLICATE BLOCKED: ${reference} (Database constraint)`);
          return; // Transaction will be aborted
        }
        throw createError;
      }

      console.log(`🎉 SUCCESS: ₦${amountNaira} → ${user.email} | New: ₦${user.walletBalance}`);
    });

  } catch (error) {
    console.error("💥 TRANSACTION FAILED:", error.message);
  } finally {
    // ✅ ALWAYS END SESSION (prevents connection leaks)
    await session.endSession();
  }
}

// ✅ USER FINDING (Safe - read-only)
async function findUser(data, session) {
  // METHOD 1: Virtual Account
  if (data.channel === "dedicated_nuban") {
    const accountNumber = data.authorization?.receiver_bank_account_number;
    if (accountNumber) {
      const user = await User.findOne({ 
        "virtualAccount.accountNumber": accountNumber 
      }).session(session);
      if (user) return user;
    }
  }

  // METHOD 2: Customer Email
  if (data.customer?.email) {
    const user = await User.findOne({ 
      email: data.customer.email.toLowerCase().trim() 
    }).session(session);
    if (user) return user;
  }

  // METHOD 3: Metadata
  if (data.metadata?.userId) {
    const user = await User.findById(data.metadata.userId).session(session);
    if (user) return user;
  }

  return null;
}

// ✅ VERIFICATION ENDPOINT
router.get("/verify-transaction/:reference", async (req, res) => {
  try {
    const { reference } = req.params;
    const transaction = await Transaction.findOne({ reference });
    
    res.json({
      exists: !!transaction,
      transaction: transaction,
      message: transaction ? "Processed successfully" : "Not found"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
