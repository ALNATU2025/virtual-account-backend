// routes/webhooks.js - 
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const Transaction = require("../models/Transaction");
const { syncVirtualAccountTransferWithMainBackend } = require("../utils/syncVirtualAccount");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// ✅ USE RAW BODY PARSER
router.post("/virtual-account", express.raw({ type: 'application/json' }), async (req, res) => {
  console.log("💰 PAYSTACK WEBHOOK RECEIVED");
  
  // ✅ IMMEDIATE RESPONSE
  res.status(200).send("OK");

  try {
    const signature = req.headers["x-paystack-signature"];
    if (!signature) {
      console.log("❌ Missing signature");
      return;
    }

    // ✅ VERIFY SIGNATURE
    const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(req.body).digest("hex");
    if (hash !== signature) {
      console.log("❌ Invalid signature");
      return;
    }

    const event = JSON.parse(req.body.toString());
    console.log("🔔 Event:", event.event);

    // ✅ PROCESS SUCCESSFUL PAYMENTS
    if (event.event === "charge.success" && event.data?.status === "success") {
      await processPayment(event.data);
    }

  } catch (error) {
    console.error("💥 Webhook error:", error.message);
  }
});

async function processPayment(data) {
  const reference = data.reference;
  const amountNaira = Number(data.amount) / 100;
  
  console.log(`\n💰 PROCESSING: ${reference} | ₦${amountNaira}`);

  const session = await mongoose.startSession();
  
  try {
    await session.withTransaction(async () => {
      // ✅ CHECK FOR DUPLICATES
      const existing = await Transaction.findOne({ reference }).session(session);
      if (existing) {
        console.log(`⏭️ ALREADY PROCESSED: ${reference}`);
        return;
      }

      // ✅ FIND USER
      const user = await findUser(data, session);
      if (!user) {
        console.log("❌ USER NOT FOUND");
        console.log("🔍 Available data:", {
          virtualAccount: data.authorization?.receiver_bank_account_number,
          customerEmail: data.customer?.email,
          metadataUserId: data.metadata?.userId
        });
        return;
      }

      console.log(`✅ USER FOUND: ${user.email} | Balance: ₦${user.walletBalance}`);

      // ✅ CREDIT WALLET
      const balanceBefore = user.walletBalance;
      user.walletBalance += amountNaira;
      await user.save({ session });

      // ✅ CREATE TRANSACTION (MATCHES YOUR ENUM VALUES)
      const transactionData = {
        userId: user._id,
        type: "virtual_account_topup", // ✅ MATCHES YOUR ENUM
        amount: amountNaira,
        status: "Successful", // ✅ MUST BE 'Successful' (capital S)
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

      console.log(`🎉 SUCCESS: ₦${amountNaira} → ${user.email}`);
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
    console.error("💥 TRANSACTION FAILED:", error.message);
    // Check if it's a validation error
    if (error.name === 'ValidationError') {
      console.error("🔍 Validation errors:", error.errors);
    }
  } finally {
    session.endSession();
  }
}

// ✅ USER FINDING
async function findUser(data, session) {
  const channel = data.channel;
  
  // METHOD 1: Virtual Account
  if (channel === "dedicated_nuban") {
    const accountNumber = data.authorization?.receiver_bank_account_number;
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
    const user = await User.findOne({ 
      email: data.customer.email.toLowerCase().trim() 
    }).session(session);
    if (user) {
      console.log(`✅ Found via email: ${data.customer.email}`);
      return user;
    }
  }

  // METHOD 3: Metadata
  if (data.metadata?.userId) {
    const user = await User.findById(data.metadata.userId).session(session);
    if (user) {
      console.log(`✅ Found via userId: ${data.metadata.userId}`);
      return user;
    }
  }

  return null;
}

// ✅ TEST ENDPOINT
router.post("/test", async (req, res) => {
  try {
    const { accountNumber, email, amount = 1000 } = req.body;
    
    const testData = {
      reference: `test_${Date.now()}`,
      amount: amount * 100,
      status: "success",
      channel: "dedicated_nuban",
      authorization: {
        receiver_bank_account_number: accountNumber
      },
      customer: {
        email: email
      }
    };

    console.log("🧪 TESTING:", testData);
    await processPayment(testData);
    
    res.json({ 
      success: true, 
      message: "Test completed - check server logs"
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
      transaction: transaction ? {
        type: transaction.type,
        status: transaction.status,
        amount: transaction.amount,
        userId: transaction.userId,
        description: transaction.description
      } : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
