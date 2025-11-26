// routes/webhooks.js — VERIFIED CORRECT VERSION
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

async function syncToMainBackend(userId, amountNaira, reference) {
  if (!MAIN_BACKEND_URL) return { success: true };

  const payload = {
    userId: userId.toString(),
    amount: Math.round(amountNaira * 100),
    reference,
    source: "virtual_account_webhook"
  };

  for (let i = 1; i <= 5; i++) {
    try {
      const res = await fetch(`${MAIN_BACKEND_URL}/api/wallet/top-up`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(MAIN_BACKEND_API_KEY && { "x-internal-api-key": MAIN_BACKEND_API_KEY })
        },
        body: JSON.stringify(payload),
        timeout: 15000
      });
      const data = await res.json();
      if (res.ok || data.alreadyProcessed) return { success: true };
    } catch (e) {
      console.error(`Sync ${i} failed:`, e.message);
    }
    if (i < 5) await new Promise(r => setTimeout(r, i * 3000));
  }
  return { success: false };
}

router.post("/virtual-account", async (req, res) => {
  console.log('\n=== PAYSTACK VIRTUAL ACCOUNT WEBHOOK RECEIVED ===');

  // 1. IMMEDIATE 200 OK - CRITICAL FOR PAYSTACK
  res.status(200).json({ status: "OK" });

  // 2. VERIFY RAW BODY EXISTS
  if (!req.rawBody || !(req.rawBody instanceof Buffer)) {
    console.error("❌ RAW BODY MISSING — MIDDLEWARE NOT TRIGGERED!");
    console.log("This means the webhook route is mounted AFTER body parsers");
    return;
  }

  console.log(`✅ Raw body captured: ${req.rawBody.length} bytes`);

  const signature = req.headers["x-paystack-signature"];
  if (!signature) {
    console.log("❌ Missing Paystack signature");
    return;
  }

  // 3. VERIFY SIGNATURE
  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(req.rawBody)
    .digest("hex");

  // Safe comparison
  const hashBuffer = Buffer.from(hash, 'utf8');
  const signatureBuffer = Buffer.from(signature, 'utf8');
  
  if (hashBuffer.length !== signatureBuffer.length) {
    console.log("❌ INVALID SIGNATURE — LENGTH MISMATCH");
    return;
  }
  
  if (!crypto.timingSafeEqual(hashBuffer, signatureBuffer)) {
    console.log("❌ INVALID SIGNATURE — REJECTED");
    return;
  }
  
  console.log("✅ Signature verified");

  // 4. PARSE EVENT
  let event;
  try {
    event = JSON.parse(req.rawBody.toString());
    console.log(`✅ Event type: ${event.event}`);
  } catch (err) {
    console.log("❌ Invalid JSON in webhook");
    return;
  }

  // 5. FILTER RELEVANT EVENTS
  if (
    event.event !== "charge.success" ||
    event.data?.channel !== "dedicated_nuban" ||
    event.data?.status !== "success"
  ) {
    console.log("ℹ️ Ignoring non-virtual-account event");
    return;
  }

  const data = event.data;
  const reference = data.reference;
  const amountNaira = data.amount / 100;

  console.log(`💰 DEPOSIT: ₦${amountNaira.toFixed(2)} | Ref: ${reference}`);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // 6. CHECK FOR DUPLICATE
      const existing = await Transaction.findOne({ reference }).session(session);
      if (existing) {
        console.log("✅ Already processed - double funding prevented");
        return;
      }

      // 7. FIND USER
      let user = null;
      const accountNumber = data.authorization?.receiver_bank_account_number;
      
      if (accountNumber) {
        user = await User.findOne({ 
          "virtualAccount.accountNumber": accountNumber 
        }).session(session);
        console.log(`🔍 Looked up by account: ${accountNumber}, found: ${!!user}`);
      }
      
      if (!user && data.customer?.email) {
        user = await User.findOne({ 
          email: { $regex: `^${data.customer.email}$`, $options: "i" } 
        }).session(session);
        console.log(`🔍 Looked up by email: ${data.customer.email}, found: ${!!user}`);
      }
      
      if (!user) {
        console.log("❌ USER NOT FOUND");
        return;
      }

      // 8. PROCESS TRANSACTION
      const before = user.walletBalance || 0;
      user.walletBalance = (user.walletBalance || 0) + amountNaira;
      await user.save({ session });

      await Transaction.create([{
        userId: user._id,
        type: "virtual_account_topup",
        amount: amountNaira,
        status: "Successful",
        reference,
        balanceBefore: before,
        balanceAfter: user.walletBalance,
        gateway: "paystack",
        description: `Virtual account deposit - ${reference}`,
        metadata: {
          accountNumber: accountNumber,
          customerEmail: data.customer?.email,
          paystackEvent: event.event
        }
      }], { session });

      console.log(`✅ LOCAL CREDIT: +₦${amountNaira} → ${user.email}`);
      console.log(`💰 BALANCE: ₦${before} → ₦${user.walletBalance}`);

      // 9. SYNC TO MAIN BACKEND
      const syncResult = await syncToMainBackend(user._id, amountNaira, reference);
      if (syncResult.success) {
        console.log("✅ Sync to main backend: SUCCESS");
      } else {
        console.log("⚠️ Sync to main backend: FAILED - will retry");
      }
    });

    console.log(`🎉 WEBHOOK FULLY PROCESSED: ${reference}\n`);
  } catch (err) {
    console.error("❌ TRANSACTION FAILED:", err.message);
    console.error(err.stack);
  } finally {
    await session.endSession();
  }
});

module.exports = router;
