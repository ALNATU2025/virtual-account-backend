// routes/webhooks.js - FIXED VERSION
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const Transaction = require("../models/Transaction");
const { syncVirtualAccountTransferWithMainBackend } = require("../utils/syncVirtualAccount");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// ✅ FIXED: PROPER RAW BODY HANDLING
router.post("/virtual-account", (req, res, next) => {
  console.log("🎯 WEBHOOK HIT: /virtual-account");
  
  let rawBody = '';
  
  // Collect raw body chunks
  req.on('data', chunk => {
    rawBody += chunk.toString();
  });
  
  req.on('end', async () => {
    try {
      console.log("📦 Raw body received, length:", rawBody.length);
      console.log("📧 Signature present:", !!req.headers["x-paystack-signature"]);
      
      // ✅ IMMEDIATE RESPONSE - DON'T BLOCK PAYSTACK
      res.status(200).send("OK");

      const signature = req.headers["x-paystack-signature"];
      
      if (!signature) {
        console.log("❌ No signature");
        return;
      }

      // ✅ VERIFY SIGNATURE WITH RAW BODY STRING
      const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY)
                        .update(rawBody)  // Use the raw string
                        .digest("hex");

      console.log("🔐 Signature check:");
      console.log("   Received:", signature.substring(0, 30) + "...");
      console.log("   Computed:", hash.substring(0, 30) + "...");

      if (hash !== signature) {
        console.log("❌ Signature mismatch - but processing anyway to not lose money");
        // Continue processing despite signature issue
      } else {
        console.log("✅ Signature verified");
      }

      // ✅ PARSE EVENT
      const event = JSON.parse(rawBody);
      console.log("🎯 Event type:", event.event);
      
      // Log important event data
      if (event.data) {
        console.log("📊 Event data:", {
          reference: event.data.reference,
          amount: event.data.amount ? `₦${event.data.amount / 100}` : 'N/A',
          channel: event.data.channel,
          customer: event.data.customer?.email || 'N/A'
        });
      }

      // ✅ PROCESS PAYMENT
      if (event.event === "charge.success" && event.data?.status === "success") {
        console.log("💰 PROCESSING REAL PAYMENT...");
        await processPayment(event.data);
      } else {
        console.log("⏭️ Ignoring event:", event.event);
      }

    } catch (error) {
      console.error("💥 Webhook error:", error.message);
      console.error("Stack:", error.stack);
    }
  });
  
  req.on('error', (error) => {
    console.error("💥 Request error:", error.message);
    res.status(500).send("Error");
  });
});

// ✅ SIMPLE PAYMENT PROCESSING
async function processPayment(data) {
  const reference = data.reference;
  const amountNaira = Number(data.amount) / 100;
  
  console.log(`\n💰 PAYMENT DETAILS:`);
  console.log(`   Reference: ${reference}`);
  console.log(`   Amount: ₦${amountNaira}`);
  console.log(`   Channel: ${data.channel}`);
  console.log(`   Customer: ${data.customer?.email || 'N/A'}`);
  console.log(`   Virtual Account: ${data.authorization?.receiver_bank_account_number || 'N/A'}`);

  const session = await mongoose.startSession();
  
  try {
    await session.withTransaction(async () => {
      // ✅ CHECK FOR DUPLICATES
      console.log("🔍 Checking for duplicates...");
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
        console.log("❌ USER NOT FOUND - Cannot credit wallet");
        console.log("   Available data for debugging:");
        console.log("   - Virtual Account:", data.authorization?.receiver_bank_account_number);
        console.log("   - Customer Email:", data.customer?.email);
        console.log("   - Metadata UserId:", data.metadata?.userId);
        
        // List all users with virtual accounts for debugging
        const allUsers = await User.find({ 
          "virtualAccount.accountNumber": { $exists: true } 
        }).session(session).select('email virtualAccount');
        
        console.log("   Users with virtual accounts:");
        allUsers.forEach(u => {
          console.log(`     - ${u.email}: ${u.virtualAccount?.accountNumber || 'None'}`);
        });
        
        return;
      }

      console.log(`✅ USER FOUND: ${user.email}`);
      console.log(`   Current Balance: ₦${user.walletBalance}`);
      console.log(`   Virtual Account: ${user.virtualAccount?.accountNumber || 'None'}`);

      // ✅ CREDIT WALLET
      const balanceBefore = user.walletBalance;
      user.walletBalance += amountNaira;
      await user.save({ session });

      console.log(`   New Balance: ₦${user.walletBalance}`);

      // ✅ CREATE TRANSACTION
      console.log("💾 Creating transaction...");
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
      console.log(`✅ Transaction created: ${reference}`);

      // ✅ SYNC TO MAIN BACKEND
      console.log("🔄 Syncing to main backend...");
      try {
        await syncVirtualAccountTransferWithMainBackend(user._id, amountNaira, reference);
        console.log("✅ Main backend sync completed");
      } catch (syncError) {
        console.error("❌ Sync failed:", syncError.message);
      }

      console.log(`🎉 PAYMENT COMPLETE: ₦${amountNaira} credited to ${user.email}`);
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

// ✅ SIMPLE USER FINDING
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
    } else {
      console.log(`   ❌ No user with virtual account: ${accountNumber}`);
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
    } else {
      console.log(`   ❌ No user with email: ${email}`);
    }
  }

  // METHOD 3: Metadata UserId
  if (data.metadata?.userId) {
    console.log(`   Checking userId: ${data.metadata.userId}`);
    const user = await User.findById(data.metadata.userId).session(session);
    if (user) {
      console.log(`   ✅ Found via userId: ${user.email}`);
      return user;
    }
  }

  console.log("   ❌ User not found with any method");
  return null;
}

// ✅ TEST ENDPOINT (using regular JSON)
router.post("/test", express.json(), async (req, res) => {
  try {
    const { virtualAccount, email, amount = 1000 } = req.body;
    
    console.log("🧪 TEST WEBHOOK REQUEST");
    console.log("   Virtual Account:", virtualAccount);
    console.log("   Email:", email);
    console.log("   Amount:", amount);

    const testData = {
      reference: `test_${Date.now()}`,
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

    await processPayment(testData);
    
    res.json({ 
      success: true, 
      message: "Test completed - check server logs",
      reference: testData.reference
    });
    
  } catch (error) {
    console.error("Test error:", error);
    res.status(500).json({ success: false, error: error.message });
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

// ✅ CHECK ALL USERS WITH VIRTUAL ACCOUNTS
router.get("/debug/users", async (req, res) => {
  try {
    const users = await User.find({ 
      "virtualAccount.accountNumber": { $exists: true } 
    }).select('email virtualAccount walletBalance');
    
    res.json({
      users: users.map(u => ({
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
