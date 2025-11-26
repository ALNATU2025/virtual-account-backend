// routes/webhooks.js — FIXED DUPLICATE & SYNC ISSUES
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

// Track processed webhooks to prevent duplicates
const processedWebhooks = new Set();

// Enhanced sync function
async function syncToMainBackend(userId, amountNaira, reference) {
  if (!MAIN_BACKEND_URL) {
    console.log('⚠️ MAIN_BACKEND_URL not set - skipping sync');
    return { success: true, skipped: true };
  }

  const payload = {
    userId: userId.toString(),
    amount: Math.round(amountNaira * 100), // Convert to kobo
    reference: reference,
    description: `Virtual account deposit - ${reference}`,
    source: "virtual_account_webhook",
    timestamp: new Date().toISOString()
  };

  console.log(`🔄 Syncing to main backend: ${MAIN_BACKEND_URL}/api/wallet/top-up`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`   Attempt ${attempt}...`);
      
      const response = await fetch(`${MAIN_BACKEND_URL}/api/wallet/top-up`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(MAIN_BACKEND_API_KEY && { 
            "x-internal-api-key": MAIN_BACKEND_API_KEY
          })
        },
        body: JSON.stringify(payload),
        timeout: 10000
      });

      const responseText = await response.text();
      console.log(`   Response status: ${response.status}`);
      
      let data;
      try {
        data = JSON.parse(responseText);
      } catch {
        data = { rawResponse: responseText };
      }

      if (response.ok) {
        console.log('✅ Sync to main backend: SUCCESS');
        return { success: true, data };
      }

      // Handle specific error cases
      if (response.status === 409 || data.alreadyProcessed) {
        console.log('✅ Sync: Already processed on main backend');
        return { success: true, alreadyProcessed: true };
      }

      if (response.status === 404) {
        console.log('❌ Sync: Endpoint not found (404)');
        return { success: false, error: 'Endpoint not found' };
      }

      console.log(`❌ Sync failed: HTTP ${response.status}`, data);

      // Wait before retry
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }

    } catch (error) {
      console.log(`❌ Sync error (attempt ${attempt}):`, error.message);
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }
    }
  }

  return { success: false, error: 'All sync attempts failed' };
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

  // Clean old entries from memory (prevent memory leaks)
  if (processedWebhooks.size > 1000) {
    const firstKey = processedWebhooks.values().next().value;
    processedWebhooks.delete(firstKey);
  }

  const session = await mongoose.startSession();
  
  try {
    await session.withTransaction(async () => {
      // 7. CHECK FOR DUPLICATE TRANSACTION (Database level)
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

      // 9. PROCESS TRANSACTION LOCALLY
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
          webhookId: webhookId
        },
        createdAt: new Date()
      }], { session });

      console.log(`✅ LOCAL CREDIT: +₦${amountNaira} → ${user.email}`);
      console.log(`💰 BALANCE: ₦${balanceBefore} → ₦${newBalance}`);

      // 11. SYNC TO MAIN BACKEND
      const syncResult = await syncToMainBackend(user._id, amountNaira, reference);
      
      if (syncResult.success) {
        console.log('🎉 WEBHOOK FULLY PROCESSED + SYNC SUCCESS');
      } else {
        console.log('⚠️ WEBHOOK PROCESSED LOCALLY BUT SYNC FAILED');
        // You might want to queue this for retry later
      }
    });

  } catch (error) {
    console.error("❌ TRANSACTION FAILED:", error.message);
    // Remove from processed cache if transaction failed
    processedWebhooks.delete(webhookKey);
  } finally {
    await session.endSession();
  }
});

module.exports = router;
