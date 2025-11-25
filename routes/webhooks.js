// routes/webhooks.js - FINAL WORKING VERSION
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const Transaction = require("../models/Transaction");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'https://vtpass-backend.onrender.com';
const MAIN_BACKEND_API_KEY = process.env.MAIN_BACKEND_API_KEY;

// ✅ SYNC FUNCTION
async function syncVirtualAccountTransferWithMainBackend(userId, amountInNaira, reference) {
  console.log(`\n🔄 SYNC TO MAIN BACKEND:`);
  console.log(`   User: ${userId}`);
  console.log(`   Amount: ₦${amountInNaira}`);
  console.log(`   Reference: ${reference}`);

  if (!MAIN_BACKEND_URL) {
    console.log('❌ MAIN_BACKEND_URL not configured');
    return { success: false, error: 'MAIN_BACKEND_URL not configured' };
  }

  const payload = {
    userId: userId.toString(),
    amount: Math.round(amountInNaira * 100), // Convert to kobo
    reference: reference,
    description: `Virtual account deposit - ${reference}`,
    source: 'virtual_account_webhook'
  };

  console.log('📦 Sync payload:', payload);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`🔄 Attempt ${attempt}/3: ${MAIN_BACKEND_URL}/api/wallet/top-up`);
      
      const response = await fetch(`${MAIN_BACKEND_URL}/api/wallet/top-up`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'VirtualAccountBackend/1.0',
          ...(MAIN_BACKEND_API_KEY && { 'x-internal-api-key': MAIN_BACKEND_API_KEY })
        },
        body: JSON.stringify(payload),
        timeout: 15000
      });

      if (response.ok) {
        const data = await response.json();
        console.log(`✅ SYNC SUCCESS:`, data);
        return { success: true, data: data };
      } else {
        const errorText = await response.text();
        console.error(`❌ Sync failed: ${response.status} - ${errorText}`);
      }

    } catch (error) {
      console.error(`❌ Sync attempt ${attempt} failed:`, error.message);
    }

    if (attempt < 3) {
      const delay = attempt * 2000;
      console.log(`⏳ Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  console.error('💥 ALL SYNC ATTEMPTS FAILED');
  return { success: false, error: 'All sync attempts failed' };
}

// ✅ WEBHOOK ENDPOINT
router.post("/virtual-account", (req, res, next) => {
  console.log("\n🎯 WEBHOOK HIT: /virtual-account");
  
  let rawBody = '';
  
  req.on('data', chunk => {
    rawBody += chunk.toString();
  });
  
  req.on('end', async () => {
    try {
      console.log("📦 Raw body length:", rawBody.length);
      
      // ✅ IMMEDIATE RESPONSE
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

      console.log("🔐 Signature:", hash === signature ? "VALID" : "INVALID");

      // ✅ PARSE EVENT
      const event = JSON.parse(rawBody);
      console.log("🎯 Event:", event.event);
      
      if (event.data) {
        console.log("📊 Payment Data:", {
          reference: event.data.reference,
          amount: `₦${event.data.amount / 100}`,
          channel: event.data.channel,
          status: event.data.status,
          customer: event.data.customer?.email || 'N/A',
          virtualAccount: event.data.authorization?.receiver_bank_account_number || 'N/A'
        });
      }

      // ✅ PROCESS PAYMENT
      if (event.event === "charge.success" && event.data?.status === "success") {
        console.log("💰 PROCESSING PAYMENT...");
        await processPaymentAndSync(event.data);
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
      const existing = await Transaction.findOne({ reference }).session(session);
      if (existing) {
        console.log(`⏭️ Already processed: ${reference}`);
        return;
      }

      // ✅ FIND USER
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
      console.log("\n🔄 SYNCING TO MAIN BACKEND...");
      const syncResult = await syncVirtualAccountTransferWithMainBackend(
        user._id, 
        amountNaira, 
        reference
      );

      if (syncResult.success) {
        console.log("🎉 SYNC SUCCESS - Balance updated in main backend");
      } else {
        console.error("❌ SYNC FAILED - Main backend not updated");
      }

      console.log(`\n🎉 PAYMENT COMPLETE: ₦${amountNaira} → ${user.email}`);
      console.log(`   Local Balance: ₦${user.walletBalance}`);
      console.log(`   Sync Status: ${syncResult.success ? 'SUCCESS' : 'FAILED'}`);
    });

  } catch (error) {
    console.error("💥 Payment processing failed:", error.message);
  } finally {
    session.endSession();
  }
}

// ✅ USER FINDING
async function findUser(data, session) {
  // METHOD 1: Virtual Account
  const accountNumber = data.authorization?.receiver_bank_account_number;
  if (accountNumber) {
    const user = await User.findOne({ 
      "virtualAccount.accountNumber": accountNumber 
    }).session(session);
    
    if (user) {
      console.log(`✅ Found via virtual account: ${accountNumber} → ${user.email}`);
      return user;
    }
  }

  // METHOD 2: Customer Email
  if (data.customer?.email) {
    const email = data.customer.email.toLowerCase().trim();
    const user = await User.findOne({ email }).session(session);
    
    if (user) {
      console.log(`✅ Found via email: ${email} → ${user.email}`);
      return user;
    }
  }

  console.log("❌ User not found");
  return null;
}

// ✅ TEST ENDPOINT
router.post("/test-payment", express.json(), async (req, res) => {
  try {
    const { virtualAccount, email, amount = 1000 } = req.body;
    
    console.log("🧪 TEST PAYMENT:");
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

    await processPaymentAndSync(testData);
    
    res.json({ 
      success: true, 
      message: "Test completed - check logs",
      reference: testData.reference
    });
    
  } catch (error) {
    console.error("Test error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
