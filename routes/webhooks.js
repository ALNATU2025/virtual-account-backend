// routes/webhooks.js - DEBUG VERSION
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const Transaction = require("../models/Transaction");
const { syncVirtualAccountTransferWithMainBackend } = require("../utils/syncVirtualAccount");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// ✅ DEBUG WEBHOOK - WILL SHOW EVERYTHING
router.post("/virtual-account", express.raw({ type: 'application/json' }), async (req, res) => {
  console.log("🔔 WEBHOOK RECEIVED - STARTING DEBUG...");
  
  // Store the raw body
  const rawBody = req.body.toString('utf8');
  
  // ✅ IMMEDIATE RESPONSE
  res.status(200).send("OK");

  try {
    const signature = req.headers["x-paystack-signature"];
    console.log("📧 Headers received:", {
      signature: signature ? "Present" : "Missing",
      contentType: req.headers["content-type"]
    });

    if (!signature) {
      console.log("❌ Missing signature");
      return;
    }

    // ✅ VERIFY SIGNATURE
    const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
    console.log("🔐 Signature check:", {
      received: signature.substring(0, 20) + "...",
      computed: hash.substring(0, 20) + "...",
      match: hash === signature
    });

    if (hash !== signature) {
      console.log("❌ Invalid signature");
      return;
    }

    // ✅ PARSE THE JSON
    const event = JSON.parse(rawBody);
    console.log("📦 FULL EVENT DATA:", JSON.stringify(event, null, 2));

    // ✅ PROCESS SUCCESSFUL PAYMENTS
    if (event.event === "charge.success" && event.data?.status === "success") {
      console.log("🎯 Processing successful charge...");
      await processPayment(event.data);
    } else {
      console.log("⏭️ Ignoring event:", event.event);
    }

  } catch (error) {
    console.error("💥 Webhook error:", error.message);
    console.error("Stack:", error.stack);
  }
});

async function processPayment(data) {
  const reference = data.reference;
  const amountNaira = Number(data.amount) / 100;
  
  console.log(`\n💰 PROCESSING PAYMENT:`);
  console.log(`📦 Reference: ${reference}`);
  console.log(`💵 Amount: ₦${amountNaira}`);
  console.log(`📱 Channel: ${data.channel}`);
  console.log(`🔍 Full payment data:`, JSON.stringify(data, null, 2));

  const session = await mongoose.startSession();
  
  try {
    await session.withTransaction(async () => {
      // ✅ CHECK FOR DUPLICATES
      console.log("🔍 Checking for duplicate transactions...");
      const existing = await Transaction.findOne({ reference }).session(session);
      if (existing) {
        console.log(`⏭️ ALREADY PROCESSED: ${reference}`);
        return;
      }
      console.log("✅ No duplicate found");

      // ✅ FIND USER WITH DETAILED DEBUGGING
      console.log("🔍 SEARCHING FOR USER...");
      const user = await findUser(data, session);
      
      if (!user) {
        console.log("❌ USER NOT FOUND - Cannot process payment");
        console.log("🔍 Available user data in webhook:");
        console.log("   - Channel:", data.channel);
        console.log("   - Virtual Account:", data.authorization?.receiver_bank_account_number);
        console.log("   - Customer Email:", data.customer?.email);
        console.log("   - Metadata UserId:", data.metadata?.userId);
        console.log("   - Recipient Account:", data.recipient?.account_number);
        console.log("   - Custom Fields:", data.metadata?.custom_fields);
        
        // Let's check what users exist in the database
        const allUsers = await User.find({}).session(session).select('email virtualAccount');
        console.log("🔍 ALL USERS IN DATABASE:");
        allUsers.forEach(u => {
          console.log(`   - ${u.email}: virtualAccount=${u.virtualAccount?.accountNumber || 'None'}`);
        });
        
        return;
      }

      console.log(`✅ USER FOUND: ${user.email}`);
      console.log(`📊 Balance Before: ₦${user.walletBalance}`);
      console.log(`🏦 Virtual Account: ${user.virtualAccount?.accountNumber || 'None'}`);

      // ✅ CREDIT WALLET
      const balanceBefore = user.walletBalance;
      user.walletBalance += amountNaira;
      await user.save({ session });

      // ✅ CREATE TRANSACTION
      console.log("💾 Creating transaction record...");
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
          virtualAccount: data.authorization?.receiver_bank_account_number || "N/A"
        }
      };

      await Transaction.create([transactionData], { session });

      console.log(`🎉 PAYMENT SUCCESS!`);
      console.log(`✅ Credited: ₦${amountNaira} to ${user.email}`);
      console.log(`💰 New Balance: ₦${user.walletBalance}`);
      console.log(`📝 Transaction Recorded: ${reference}`);

      // ✅ SYNC TO MAIN BACKEND
      try {
        console.log("🔄 Syncing with main backend...");
        await syncVirtualAccountTransferWithMainBackend(user._id, amountNaira, reference);
        console.log("✅ Main backend sync completed");
      } catch (syncError) {
        console.error("⚠️ Sync failed:", syncError.message);
      }
    });

  } catch (error) {
    console.error("💥 TRANSACTION FAILED:", error.message);
    if (error.name === 'ValidationError') {
      console.error("🔍 Validation errors:", JSON.stringify(error.errors, null, 2));
    }
  } finally {
    session.endSession();
  }
}

// ✅ USER FINDING WITH EXTENSIVE DEBUGGING
async function findUser(data, session) {
  const channel = data.channel;
  
  console.log("🔍 USER SEARCH STARTED...");
  console.log("   Channel:", channel);
  console.log("   Available data:", {
    virtualAccount: data.authorization?.receiver_bank_account_number,
    email: data.customer?.email,
    userId: data.metadata?.userId,
    recipient: data.recipient?.account_number
  });

  // METHOD 1: Virtual Account
  if (channel === "dedicated_nuban") {
    const accountNumber = data.authorization?.receiver_bank_account_number;
    console.log(`   🔍 METHOD 1: Virtual Account Search: ${accountNumber}`);
    
    if (accountNumber) {
      const user = await User.findOne({ 
        "virtualAccount.accountNumber": accountNumber 
      }).session(session);
      
      if (user) {
        console.log(`   ✅ FOUND: Virtual account ${accountNumber} → ${user.email}`);
        return user;
      } else {
        console.log(`   ❌ NOT FOUND: No user with virtual account ${accountNumber}`);
      }
    } else {
      console.log(`   ❌ SKIPPED: No virtual account number in webhook data`);
    }
  }

  // METHOD 2: Customer Email
  if (data.customer?.email) {
    const email = data.customer.email.toLowerCase().trim();
    console.log(`   🔍 METHOD 2: Email Search: ${email}`);
    
    const user = await User.findOne({ email }).session(session);
    if (user) {
      console.log(`   ✅ FOUND: Email ${email} → ${user.email}`);
      return user;
    } else {
      console.log(`   ❌ NOT FOUND: No user with email ${email}`);
    }
  }

  // METHOD 3: Metadata UserId
  if (data.metadata?.userId) {
    console.log(`   🔍 METHOD 3: UserId Search: ${data.metadata.userId}`);
    const user = await User.findById(data.metadata.userId).session(session);
    if (user) {
      console.log(`   ✅ FOUND: UserId ${data.metadata.userId} → ${user.email}`);
      return user;
    } else {
      console.log(`   ❌ NOT FOUND: No user with ID ${data.metadata.userId}`);
    }
  }

  // METHOD 4: Recipient Account
  if (data.recipient?.account_number) {
    console.log(`   🔍 METHOD 4: Recipient Account: ${data.recipient.account_number}`);
    const user = await User.findOne({ 
      "virtualAccount.accountNumber": data.recipient.account_number 
    }).session(session);
    if (user) {
      console.log(`   ✅ FOUND: Recipient account ${data.recipient.account_number} → ${user.email}`);
      return user;
    } else {
      console.log(`   ❌ NOT FOUND: No user with recipient account ${data.recipient.account_number}`);
    }
  }

  console.log("   ❌ ALL USER SEARCH METHODS FAILED");
  return null;
}

// ✅ TEST WITH REAL DATA
router.post("/test-real", express.json(), async (req, res) => {
  try {
    const { virtualAccount, email, amount = 1000 } = req.body;
    
    const testData = {
      reference: `test_real_${Date.now()}`,
      amount: amount * 100,
      status: "success",
      channel: "dedicated_nuban",
      authorization: {
        receiver_bank_account_number: virtualAccount
      },
      customer: {
        email: email
      }
    };

    console.log("🧪 REAL TEST STARTING...");
    await processPayment(testData);
    
    res.json({ 
      success: true, 
      message: "Test completed - check server logs for details",
      reference: testData.reference
    });
    
  } catch (error) {
    console.error("Test error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ CHECK ALL TRANSACTIONS (for debugging)
router.get("/debug/transactions", async (req, res) => {
  try {
    const transactions = await Transaction.find({}).sort({ createdAt: -1 }).limit(10);
    const users = await User.find({}).select('email virtualAccount walletBalance');
    
    res.json({
      recentTransactions: transactions.map(t => ({
        reference: t.reference,
        type: t.type,
        status: t.status,
        amount: t.amount,
        userId: t.userId,
        createdAt: t.createdAt
      })),
      allUsers: users.map(u => ({
        email: u.email,
        virtualAccount: u.virtualAccount?.accountNumber,
        walletBalance: u.walletBalance
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
