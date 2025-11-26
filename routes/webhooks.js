// routes/webhooks.js — FINAL PERFECT & BULLETPROOF (2025 EDITION)
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const Transaction = require("../models/Transaction");

// ==================== CONFIG ====================
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY?.trim();
if (!PAYSTACK_SECRET_KEY) {
  console.error("FATAL: PAYSTACK_SECRET_KEY missing");
  process.exit(1);
}

const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL?.trim();
const MAIN_BACKEND_API_KEY = process.env.MAIN_BACKEND_API_KEY?.trim();

// ==================== SYNC TO MAIN BACKEND ====================
async function syncToMainBackend(userId, amountNaira, reference) {
  if (!MAIN_BACKEND_URL) return { success: true, standalone: true };

  const payload = {
    userId: userId.toString(),
    amount: Math.round(amountNaira * 100), // kobo
    reference,
    source: "virtual_account_webhook"
  };

  for (let i = 1; i <= 5; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(`${MAIN_BACKEND_URL}/api/wallet/top-up`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(MAIN_BACKEND_API_KEY && { "x-internal-api-key": MAIN_BACKEND_API_KEY })
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeout);
      const data = await res.json();

      if (res.ok && (data.success || data.alreadyProcessed)) {
        return { success: true, alreadyProcessed: !!data.alreadyProcessed };
      }
    } catch (err) {
      console.error(`Sync attempt ${i} failed:`, err.message);
    }
    if (i < 5) await new Promise(r => setTimeout(r, i * 3000));
  }

  console.error("CRITICAL: MAIN BACKEND SYNC FAILED AFTER 5 ATTEMPTS");
  return { success: false };
}

// ==================== WEBHOOK ENDPOINT ====================
router.post("/virtual-account", async (req, res) => {
  console.log("\nPAYSTACK WEBHOOK HIT");

  // 1. IMMEDIATE 200 OK
  res.status(200).json({ status: "OK" });

  // 2. GET RAW BODY (saved by middleware in index.js)
  const rawBody = req.rawBody;
  if (!rawBody || !(rawBody instanceof Buffer)) {
    console.log("No raw body — middleware failed");
    return;
  }

  const signature = req.headers["x-paystack-signature"];
  if (!signature) {
    console.log("Missing signature");
    return;
  }

  // 3. VERIFY SIGNATURE
  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature))) {
    console.log("INVALID SIGNATURE — REJECTED");
    return;
  }
  console.log("Signature verified");

  // 4. PARSE EVENT
  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    console.log("Invalid JSON");
    return;
  }

  // 5. FILTER EVENT
  if (
    event.event !== "charge.success" ||
    event.data?.channel !== "dedicated_nuban" ||
    event.data?.status !== "success"
  ) {
    return;
  }

  const data = event.data;
  const reference = data.reference;
  const amountNaira = data.amount / 100;

  console.log(`DEPOSIT: ₦${amountNaira} | Ref: ${reference}`);

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      // IDEMPOTENCY
      if (await Transaction.findOne({ reference }).session(session)) {
        console.log("Already processed");
        return;
      }

      // FIND USER
      let user = null;
      const acc = data.authorization?.receiver_bank_account_number;
      if (acc) user = await User.findOne({ "virtualAccount.accountNumber": acc }).session(session);
      if (!user && data.customer?.email) {
        user = await User.findOne({ email: { $regex: `^${data.customer.email}$`, $options: "i" } }).session(session);
      }
      if (!user) {
        console.log("USER NOT FOUND");
        return;
      }

      // CREDIT LOCAL
      const before = user.walletBalance || 0;
      user.walletBalance = before + amountNaira;
      await user.save({ session });

      // RECORD
      await Transaction.create([{
        userId: user._id,
        type: "virtual_account_topup",
        amount: amountNaira,
        status: "Successful",
        reference,
        description: "Virtual account deposit",
        balanceBefore: before,
        balanceAfter: user.walletBalance,
        gateway: "paystack"
      }], { session });

      console.log(`LOCAL CREDIT: +₦${amountNaira} → ${user.email}`);

      // SYNC
      await syncToMainBackend(user._id, amountNaira, reference);
    });
  } catch (err) {
    console.error("TRANSACTION FAILED:", err.message);
  } finally {
    session.endSession();
  }
});

module.exports = router;
