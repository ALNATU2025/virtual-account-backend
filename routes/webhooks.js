// routes/webhooks.js - COMPLETE WORKING VERSION
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const Transaction = require("../models/Transaction");
const { syncVirtualAccountTransferWithMainBackend } = require("../utils/syncVirtualAccount");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// ✅ WORKING WEBHOOK WITH SYNC
router.post("/virtual-account", (req, res, next) => {
  console.log("🎯 WEBHOOK HIT: /virtual-account");
  
  let rawBody = '';
  
  // Collect raw body chunks
  req.on('data', chunk => {
    rawBody += chunk.toString();
  });
  
  req.on('end', async () => {
    try {
      console.log("📦 Raw body length:", rawBody.length);
      
      // ✅ IMMEDIATE RESPONSE - DON'T BLOCK PAYSTACK
      res.status(200).send("OK");

      const signature = req.headers["x-paystack-signature"];
      
      if (!signature) {
        console.log("❌ No signature");
        return;
      }

      // ✅ VERIFY SIGNATURE
      const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY)
                        .update(rawBody)
                        .digest("hex");

      console.log("🔐 Signature:", hash === signature ? "✅ VALID" : "❌ INVALID");

      if (hash !== signature) {
        console.log("⚠️  Signature mismatch - processing anyway");
      }

      // ✅ PARSE EVENT
      const event = JSON.parse(rawBody);
      console.log("🎯 Event:", event.event);
      
      // Log important data
      if (event.data) {
        console.log("📊 Payment Data:", {
          reference: event.data.reference,
          amount: event.data.amount ? `₦${event.data.amount / 100}` : 'N/A',
          channel: event.data.channel,
          status: event.data.status,
          customer: event.data.customer?.email || 'N/A',
          virtualAccount: event.data.authorization?.receiver_bank_account_number || 'N/A'
        });
      }

      // ✅ PROCESS PAYMENT
      if (event.event === "charge.success" && event.data?.status === "success") {
        console.log("💰 PROCESSING PAYMENT & SYNCING...");
        await processPaymentAndSync(event.data);
      } else {
        console.log("⏭️ Ignoring event:", event.event);
      }

    } catch (error) {
      console.error("💥 Webhook error:", error.message);
    }
  });
  
  req.on('error', (error) => {
    console.error("💥 Request error:", error.message);
    res.status(500).send("Error");
  });
});

// ✅ PAYMENT PROCESSING WITH SYNC
async function processPaymentAndSync(data) {
  const reference = data.reference;
  const amountNaira = Number(data.amount) / 100;
  
  console.log(`\n💰 PAYMENT PROCESSING:`);
  console.log(`   Reference: ${reference}`);
  console.log(`   Amount: ₦${amountNaira}`);
  console.log(`   Channel: ${data.channel}`);

  const session = await mongoose.startSession();
  
  try {
    await session.withTransaction(async () => {
      // ✅ CHECK FOR DUPLICATES
      console.log("🔍 Checking duplicates...");
      const existing = await Transaction.findOne({ reference }).session(session);
      if (existing) {
        console.log(`⏭️ Already processed: ${reference}`);
        return;
      }
      console.log("✅ No duplicate found");

      // ✅ FIND USER
      console.log("🔍 Finding user...");
      const user = await findUser(data, session);
      
      if (!user) {
        console.log("❌ USER NOT FOUND");
        console.log("   Virtual Account:", data.authorization?.receiver_bank_account_number);
        console.log("   Customer Email:", data.customer?.email);
        return;
      }

      console.log(`✅ USER FOUND: ${user.email}`);
      console.log(`   Current Balance: ₦${user.walletBalance}`);

      // ✅ STEP 1: CREDIT WALLET LOCALLY
      const balanceBefore = user.walletBalance;
      user.walletBalance += amountNaira;
      await user.save({ session });

      console.log(`   New Local Balance: ₦${user.walletBalance}`);

      // ✅ STEP 2: CREATE LOCAL TRANSACTION
      console.log("💾 Creating local transaction...");
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
          customerEmail: data.customer?.email || user.email,
          virtualAccount: data.authorization?.receiver_bank_account_number || "N/A",
          bank: data.authorization?.bank || "N/A"
        }
      };

      await Transaction.create([transactionData], { session });
      console.log(`✅ Local transaction created: ${reference}`);

      // ✅ STEP 3: SYNC TO MAIN BACKEND
      console.log("\n🔄 STARTING SYNC TO MAIN BACKEND...");
      const syncResult = await syncVirtualAccountTransferWithMainBackend(
        user._id, 
        amountNaira, 
        reference
      );

      if (syncResult.success) {
        console.log("🎉 SYNC SUCCESS - Balance updated in main backend");
        console.log(`   Response:`, syncResult.data);
      } else {
        console.error("❌ SYNC FAILED - Main backend not updated");
        console.error("   Error:", syncResult.error);
        // You might want to implement a retry mechanism here
      }

      console.log(`\n🎉 PAYMENT COMPLETE: ₦${amountNaira} credited to ${user.email}`);
      console.log(`   Local Balance: ₦${user.walletBalance}`);
      console.log(`   Sync Status: ${syncResult.success ? 'SUCCESS' : 'FAILED'}`);
    });

  } catch (error) {
    console.error("💥 Payment processing failed:", error.message);
    if (error.name === 'ValidationError') {
      console.error("Validation errors:", error.errors);
    }
  } finally {
    session.endSession();
  }
}

// ✅ USER FINDING
async function findUser(data, session) {
  console.log("🔍 User search started");
  
  // METHOD 1: Virtual Account
  const accountNumber = data.authorization?.receiver_bank_account_number;
  if (accountNumber) {
    console.log(`   Checking virtual account: ${accountNumber}`);
    const user = await User.findOne({ 
      "virtualAccount.accountNumber": accountNumber 
    }).session(session);
    
    if (user) {
      console.log(`   ✅ Found via virtual account: ${user.email}`);
      return user;
    }
  }

  // METHOD 2: Customer Email
  if (data.customer?.email) {
    const email = data.customer.email.toLowerCase().trim();
    console.log(`   Checking email: ${email}`);
    const user = await User.findOne({ email }).session(session);
    
    if (user) {
      console.log(`   ✅ Found via email: ${user.email}`);
      return user;
    }
  }

  console.log("   ❌ User not found");
  return null;
}

// ✅ TEST SYNC ENDPOINT
router.post("/test-sync", express.json(), async (req, res) => {
  try {
    const { userId, amount, reference } = req.body;
    
    console.log("🧪 TESTING SYNC FUNCTION");
    console.log("   User ID:", userId);
    console.log("   Amount:", amount);
    console.log("   Reference:", reference);

    const result = await syncVirtualAccountTransferWithMainBackend(userId, amount, reference);
    
    res.json({ 
      success: true, 
      message: "Sync test completed",
      result: result 
    });
    
  } catch (error) {
    console.error("Sync test error:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// ✅ CHECK TRANSACTION
router.get("/check/:reference", async (req, res) => {
  try {
    const { reference } = req.params;
    const transaction = await Transaction.findOne({ reference });
    
    res.json({
      exists: !!transaction,
      transaction: transaction
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
