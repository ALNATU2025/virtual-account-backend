// routes/webhooks.js — PRODUCTION READY (Sync as Background Task)
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const Transaction = require("../models/Transaction");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY?.trim();
if (!PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY missing");

const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL?.trim();
const MAIN_BACKEND_API_KEY = process.env.MAIN_BACKEND_API_KEY?.trim();

// Track processed webhooks
const processedWebhooks = new Set();

// Background sync (non-blocking)
async function backgroundSyncToMainBackend(userId, amountNaira, reference) {
  if (!MAIN_BACKEND_URL) {
    console.log('ℹ️ MAIN_BACKEND_URL not set - background sync skipped');
    return;
  }

  console.log(`🔄 Starting background sync for ref: ${reference}`);
  
  // Run in background without awaiting
  syncToMainBackend(userId, amountNaira, reference)
    .then(result => {
      if (result.success) {
        console.log(`✅ Background sync completed for ${reference}`);
      } else {
        console.log(`⚠️ Background sync failed for ${reference}:`, result.error);
      }
    })
    .catch(error => {
      console.log(`⚠️ Background sync error for ${reference}:`, error.message);
    });
}

// Main sync function (with improved error handling)
async function syncToMainBackend(userId, amountNaira, reference) {
  const payload = {
    userId: userId.toString(),
    amount: Math.round(amountNaira * 100),
    reference: reference,
    description: `Virtual account deposit - ${reference}`,
    source: "virtual_account_webhook",
    timestamp: new Date().toISOString()
  };

  for (let attempt = 1; attempt <= 2; attempt++) { // Reduced attempts
    try {
      console.log(`   Sync attempt ${attempt}...`);
      
      const response = await fetch(`${MAIN_BACKEND_URL}/api/wallet/top-up`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(MAIN_BACKEND_API_KEY && { 
            "x-internal-api-key": MAIN_BACKEND_API_KEY
          })
        },
        body: JSON.stringify(payload),
        timeout: 8000 // Shorter timeout
      });

      const responseText = await response.text();
      
      if (response.ok) {
        console.log('✅ Sync to main backend: SUCCESS');
        return { success: true };
      }

      // If main backend has issues, don't retry excessively
      if (response.status >= 500) {
        console.log(`⚠️ Main backend error (${response.status}) - will not retry`);
        return { success: false, error: 'Backend error' };
      }

      console.log(`❌ Sync failed: HTTP ${response.status}`);

    } catch (error) {
      console.log(`❌ Sync error: ${error.message}`);
    }

    // Short wait before retry
    if (attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return { success: false, error: 'Sync failed after retries' };
}

router.post("/virtual-account", async (req, res) => {
  const webhookId = `wh_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  console.log(`\n=== PAYSTACK WEBHOOK [${webhookId}] ===`);

  // 1. IMMEDIATE 200 OK
  res.status(200).json({ status: "OK", id: webhookId });

  // 2. VERIFY RAW BODY
  if (!req.rawBody || !(req.rawBody instanceof Buffer)) {
    console.error("❌ RAW BODY MISSING");
    return;
  }

  console.log(`✅ Raw body: ${req.rawBody.length} bytes`);

  // 3. VERIFY SIGNATURE
  const signature = req.headers["x-paystack-signature"];
  if (!signature) {
    console.log("❌ Missing signature");
    return;
  }

  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(req.rawBody)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature))) {
    console.log("❌ Invalid signature");
    return;
  }

  console.log("✅ Signature verified");

  // 4. PARSE EVENT
  let event;
  try {
    event = JSON.parse(req.rawBody.toString());
    console.log(`✅ Event: ${event.event}`);
  } catch (err) {
    console.log("❌ Invalid JSON");
    return;
  }

  // 5. FILTER RELEVANT EVENTS
  if (event.event !== "charge.success" || 
      event.data?.channel !== "dedicated_nuban" || 
      event.data?.status !== "success") {
    console.log("ℹ️ Ignoring irrelevant event");
    return;
  }

  const data = event.data;
  const reference = data.reference;
  const amountNaira = data.amount / 100;
  const accountNumber = data.authorization?.receiver_bank_account_number;

  console.log(`💰 Processing: ₦${amountNaira} | Ref: ${reference} | Account: ${accountNumber}`);

  // 6. DUPLICATE WEBHOOK PROTECTION
  const webhookKey = `${reference}_${data.id}_${amountNaira}`;
  if (processedWebhooks.has(webhookKey)) {
    console.log('🛑 DUPLICATE WEBHOOK - Already processed, ignoring');
    return;
  }
  processedWebhooks.add(webhookKey);

  // Clean old entries
  if (processedWebhooks.size > 1000) {
    const firstKey = processedWebhooks.values().next().value;
    processedWebhooks.delete(firstKey);
  }

  const session = await mongoose.startSession();
  
  try {
    await session.withTransaction(async () => {
      // 7. CHECK FOR DUPLICATE TRANSACTION
      const existing = await Transaction.findOne({ reference }).session(session);
      if (existing) {
        console.log("✅ Already processed in database - duplicate prevented");
        return;
      }

      // 8. FIND USER
      let user = null;
      
      if (accountNumber) {
        user = await User.findOne({ 
          "virtualAccount.accountNumber": accountNumber 
        }).session(session);
        console.log(`🔍 User lookup by account ${accountNumber}: ${user ? `FOUND (${user.email})` : 'NOT FOUND'}`);
      }
      
      if (!user && data.customer?.email) {
        user = await User.findOne({ 
          email: data.customer.email.toLowerCase().trim() 
        }).session(session);
        console.log(`🔍 User lookup by email ${data.customer.email}: ${user ? 'FOUND' : 'NOT FOUND'}`);
      }
      
      if (!user) {
        console.log("❌ User not found for this transaction");
        return;
      }

      // 9. PROCESS TRANSACTION LOCALLY (PRIMARY)
      const balanceBefore = user.walletBalance || 0;
      const newBalance = (user.walletBalance || 0) + amountNaira;
      
      user.walletBalance = newBalance;
      await user.save({ session });

      // 10. CREATE TRANSACTION RECORD
      await Transaction.create([{
        userId: user._id,
        type: "virtual_account_topup",
        amount: amountNaira,
        status: "Successful",
        reference,
        balanceBefore,
        balanceAfter: newBalance,
        gateway: "paystack",
        description: `Virtual account deposit - ${reference}`,
        metadata: {
          accountNumber: accountNumber,
          customerEmail: data.customer?.email,
          paystackEventId: data.id,
          webhookId: webhookId,
          syncedToMain: false // Track sync status
        },
        createdAt: new Date()
      }], { session });

      console.log(`✅ LOCAL CREDIT: +₦${amountNaira} → ${user.email}`);
      console.log(`💰 BALANCE: ₦${balanceBefore} → ₦${newBalance}`);
      console.log('🎉 WEBHOOK SUCCESSFULLY PROCESSED');

      // 11. START BACKGROUND SYNC (NON-BLOCKING)
      backgroundSyncToMainBackend(user._id, amountNaira, reference);
    });

  } catch (error) {
    console.error("❌ TRANSACTION FAILED:", error.message);
    processedWebhooks.delete(webhookKey);
  } finally {
    await session.endSession();
  }
});

// Add this for other Paystack payment methods
router.post("/paystack-general", async (req, res) => {
  console.log('\n=== GENERAL PAYSTACK WEBHOOK ===');
  
  // Immediate response
  res.status(200).json({ status: "OK" });

  // Verify raw body exists
  if (!req.rawBody) {
    console.error("Raw body missing");
    return;
  }

  // Verify signature
  const signature = req.headers["x-paystack-signature"];
  if (!signature) return;

  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(req.rawBody).digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature))) {
    console.log("Invalid signature");
    return;
  }

  let event;
  try {
    event = JSON.parse(req.rawBody.toString());
  } catch (err) {
    return;
  }

  console.log(`General Paystack event: ${event.event}`);

  // Handle different Paystack events here
  // card payments, bank transfers, etc.
  if (event.event === "charge.success") {
    console.log("General payment success:", event.data.reference);
    // Add your general payment processing logic here
  }
});

module.exports = router;
