// routes/webhooks.js - FINAL PRODUCTION VERSION
// Handles: Virtual Account + Card + OPay + USSD + Bank Transfer
// Zero double funding | Instant credit | Background sync

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const Transaction = require("../models/Transaction");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY?.trim();
if (!PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY missing");

// Track processed webhooks
const processedWebhooks = new Set();

// Background sync to main backend
async function backgroundSyncToMainBackend(userId, amountNaira, reference) {
  const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL?.trim();
  if (!MAIN_BACKEND_URL) return;

  console.log(`Background sync → main backend for ${reference}`);

  syncToMainBackend(userId, amountNaira, reference)
    .catch(err => console.log(`Background sync failed: ${err.message}`));
}

async function syncToMainBackend(userId, amountNaira, reference) {
  const payload = {
    userId: userId.toString(),
    amount: Math.round(amountNaira * 100),
    reference,
    description: `PayStack payment - ${reference}`,
    source: "paystack_webhook",
    timestamp: new Date().toISOString()
  };

  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(`${process.env.MAIN_BACKEND_URL}/api/wallet/top-up`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.MAIN_BACKEND_API_KEY && { "x-internal-api-key": process.env.MAIN_BACKEND_API_KEY })
        },
        body: JSON.stringify(payload),
        timeout: 8000
      });

      if (res.ok) {
        console.log('Main backend sync: SUCCESS');
        return { success: true };
      }
    } catch (e) {
      console.log(`Sync attempt ${i + 1} failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return { success: false };
}

// MAIN PAYSTACK WEBHOOK - HANDLES ALL PAYMENT METHODS
router.post("/paystack", async (req, res) => {
  const webhookId = `wh_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  console.log(`\nPAYSTACK WEBHOOK [${webhookId}]`);

  // 1. Immediate response
  res.status(200).json({ status: "OK", id: webhookId });

  // 2. Verify raw body & signature
  if (!req.rawBody) {
    console.error("RAW BODY MISSING");
    return;
  }

  const signature = req.headers["x-paystack-signature"];
  if (!signature) {
    console.log("Missing signature");
    return;
  }

  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(req.rawBody)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature))) {
    console.log("Invalid signature");
    return;
  }

  console.log("Signature verified");

  // 3. Parse event
  let event;
  try {
    event = JSON.parse(req.rawBody.toString());
  } catch (err) {
    console.log("Invalid JSON");
    return;
  }

  // 4. Only process successful payments
 if (event.event !== "charge.success" || event.data?.status !== "success") {
  console.log(`Ignored: ${event.event} | Status: ${event.data?.status || 'unknown'}`);
  return;
}

  const data = event.data;
  const reference = data.reference;
  const amountNaira = data.amount / 100;

  console.log(`PAYMENT SUCCESS: ₦${amountNaira} | Ref: ${reference} | Channel: ${data.channel}`);

  // 5. Prevent duplicates
  const key = `${reference}_${data.id}`;
  if (processedWebhooks.has(key)) {
    console.log("Duplicate webhook ignored");
    return;
  }
  processedWebhooks.add(key);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Check if already processed
      const existing = await Transaction.findOne({ reference }).session(session);
      if (existing) {
        console.log("Already credited");
        return;
      }

      // Find user by metadata.userId or email
      let user = null;
      const userId = data.metadata?.userId;
      const email = data.customer?.email;

      if (userId) {
        user = await User.findById(userId).session(session);
      }
      if (!user && email) {
        user = await User.findOne({ email: email.toLowerCase().trim() }).session(session);
      }

      if (!user) {
        console.log("User not found");
        return;
      }

      // Credit wallet
      const balanceBefore = user.walletBalance || 0;
      user.walletBalance = balanceBefore + amountNaira;
      await user.save({ session });

      // Record transaction
      await Transaction.create([{
        userId: user._id,
        type: "wallet_funding",
        amount: amountNaira,
        reference,
        status: "success",
        balanceBefore,
        balanceAfter: user.walletBalance,
        gateway: "paystack",
        description: `PayStack payment (${data.channel || 'unknown'}) - ${reference}`,
        metadata: {
          channel: data.channel,
          paystackData: data,
          webhookId
        }
      }], { session });

      console.log(`CREDITED: +₦${amountNaira} → ${user.email}`);
      console.log(`BALANCE: ₦${balanceBefore} → ₦${user.walletBalance}`);

      // Background sync
      backgroundSyncToMainBackend(user._id, amountNaira, reference);
    });
  } catch (error) {
    console.error("TRANSACTION FAILED:", error.message);
    processedWebhooks.delete(key);
  } finally {
    await session.endSession();
  }
});

module.exports = router;
