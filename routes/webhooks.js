// routes/webhooks.js - PRODUCTION VERSION
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const Transaction = require("../models/Transaction");
const { syncVirtualAccountTransferWithMainBackend } = require("../utils/syncVirtualAccount");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// ✅ PRODUCTION WEBHOOK - REAL PAYSTACK INTEGRATION
router.post("/virtual-account", express.raw({ type: 'application/json' }), async (req, res) => {
  console.log("💰 PAYSTACK PRODUCTION WEBHOOK RECEIVED");
  
  // Store the raw body for signature verification
  const rawBody = req.body.toString('utf8');
  
  try {
    const signature = req.headers["x-paystack-signature"];
    if (!signature) {
      console.log("❌ Missing PayStack signature");
      return res.status(400).send("Missing signature");
    }

    // ✅ REAL SIGNATURE VERIFICATION (Production)
    const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
    
    if (hash !== signature) {
      console.log("❌ Invalid PayStack signature");
      console.log("Expected:", hash.substring(0, 20) + "...");
      console.log("Received:", signature.substring(0, 20) + "...");
      return res.status(400).send("Invalid signature");
    }

    // ✅ Parse the JSON after signature verification
    const event = JSON.parse(rawBody);
    console.log("🔔 PayStack Event:", event.event);

    // ✅ PROCESS REAL PAYSTACK EVENTS
    if (event.event === "charge.success" && event.data?.status === "success") {
      console.log("🎯 Processing REAL payment from PayStack...");
      await processRealPayment(event.data);
    } else {
      console.log("⏭️ Ignoring event:", event.event);
    }

    // ✅ ALWAYS RETURN 200 TO PAYSTACK
    res.status(200).send("OK");

  } catch (error) {
    console.error("💥 Webhook error:", error.message);
    // STILL return 200 to PayStack even on errors
    res.status(200).send("OK");
  }
});

async function processRealPayment(data) {
  const reference = data.reference;
  const amountNaira = Number(data.amount) / 100;
  
  console.log(`\n💰 PROCESSING REAL PAYMENT FROM PAYSTACK:`);
  console.log(`📦 Reference: ${reference}`);
  console.log(`💵 Amount: ₦${amountNaira}`);
  console.log(`📱 Channel: ${data.channel}`);
  console.log(`👤 Customer: ${data.customer?.email || 'N/A'}`);

  const session = await mongoose.startSession();
  
  try {
    await session.withTransaction(async () => {
      // ✅ CHECK FOR DUPLICATES
      const existing = await Transaction.findOne({ reference }).session(session);
      if (existing) {
        console.log(`⏭️ Already processed: ${reference}`);
        return;
      }

      // ✅ FIND USER FOR REAL PAYMENT
      const user = await findUserForRealPayment(data, session);
      if (!user) {
        console.log("❌ USER NOT FOUND - Real payment cannot be credited");
        console.log("🔍 PayStack data received:", {
          channel: data.channel,
          virtualAccount: data.authorization?.receiver_bank_account_number,
          customerEmail: data.customer?.email,
          metadata: data.metadata
        });
        return;
      }

      console.log(`✅ USER FOUND: ${user.email}`);
      console.log(`📊 Balance Before: ₦${user.walletBalance}`);

      // ✅ CREDIT WALLET
      const balanceBefore = user.walletBalance;
      user.walletBalance += amountNaira;
      await user.save({ session });

      // ✅ CREATE TRANSACTION
      const transactionData = {
        userId: user._id,
        type: "virtual_account_topup",
        amount: amountNaira,
        status: "Successful",
        reference: reference,
        description: `Virtual account deposit via ${data.channel || 'PayStack'}`,
        balanceBefore: balanceBefore,
        balanceAfter: user.walletBalance,
        gateway: "paystack",
        details: {
          source: "paystack_webhook",
          channel: data.channel,
          paymentMethod: data.authorization?.channel || data.authorization?.card_type || data.channel,
          customerEmail: data.customer?.email || user.email,
          bank: data.authorization?.bank || data.authorization?.receiver_bank?.name || "N/A",
          virtualAccount: data.authorization?.receiver_bank_account_number || "N/A",
          paidAt: data.paid_at || new Date().toISOString()
        }
      };

      await Transaction.create([transactionData], { session });

      console.log(`🎉 REAL PAYMENT SUCCESS!`);
      console.log(`✅ Credited: ₦${amountNaira} to ${user.email}`);
      console.log(`💰 New Balance: ₦${user.walletBalance}`);

      // ✅ SYNC TO MAIN BACKEND
      try {
        await syncVirtualAccountTransferWithMainBackend(user._id, amountNaira, reference);
        console.log("✅ Main backend sync completed");
      } catch (syncError) {
        console.error("⚠️ Sync failed:", syncError.message);
      }
    });

  } catch (error) {
    console.error("💥 Payment processing failed:", error.message);
  } finally {
    session.endSession();
  }
}

// ✅ USER FINDING FOR REAL PAYSTACK PAYMENTS
async function findUserForRealPayment(data, session) {
  const channel = data.channel;
  
  console.log("🔍 Searching for user with real PayStack data...");

  // METHOD 1: Virtual Account Payments
  if (channel === "dedicated_nuban") {
    const accountNumber = data.authorization?.receiver_bank_account_number;
    console.log(`🔍 Virtual account search: ${accountNumber}`);
    
    if (accountNumber) {
      const user = await User.findOne({ 
        "virtualAccount.accountNumber": accountNumber 
      }).session(session);
      if (user) {
        console.log(`✅ Found via virtual account: ${accountNumber}`);
        return user;
      }
    }
  }

  // METHOD 2: Customer Email
  if (data.customer?.email) {
    const email = data.customer.email.toLowerCase().trim();
    console.log(`🔍 Email search: ${email}`);
    
    const user = await User.findOne({ email }).session(session);
    if (user) {
      console.log(`✅ Found via email: ${email}`);
      return user;
    }
  }

  // METHOD 3: Metadata
  if (data.metadata?.userId) {
    console.log(`🔍 UserId search: ${data.metadata.userId}`);
    const user = await User.findById(data.metadata.userId).session(session);
    if (user) {
      console.log(`✅ Found via userId: ${data.metadata.userId}`);
      return user;
    }
  }

  // METHOD 4: Custom Fields
  if (data.metadata?.custom_fields) {
    console.log("🔍 Checking custom fields...");
    for (let field of data.metadata.custom_fields) {
      if (field.variable_name === "account_number" || field.variable_name === "virtual_account") {
        const user = await User.findOne({ 
          "virtualAccount.accountNumber": field.value 
        }).session(session);
        if (user) return user;
      }
    }
  }

  console.log("❌ User not found with any method");
  return null;
}

// ✅ PRODUCTION HEALTH CHECK
router.get("/health", (req, res) => {
  res.json({
    status: "active",
    service: "paystack-webhook",
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  });
});

// ✅ CHECK REAL TRANSACTIONS
router.get("/transactions/:reference", async (req, res) => {
  try {
    const { reference } = req.params;
    const transaction = await Transaction.findOne({ reference });
    
    if (!transaction) {
      return res.status(404).json({ 
        exists: false, 
        message: "Transaction not found" 
      });
    }

    res.json({
      exists: true,
      transaction: {
        reference: transaction.reference,
        type: transaction.type,
        status: transaction.status,
        amount: transaction.amount,
        userId: transaction.userId,
        description: transaction.description,
        createdAt: transaction.createdAt
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
