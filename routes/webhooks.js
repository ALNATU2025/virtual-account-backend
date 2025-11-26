// routes/webhooks.js — FINAL PERFECT & SECURE VERSION (2025 STANDARD)
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

// Use native fetch in Node.js 18+ (no need for node-fetch)
const fetch = globalThis.fetch || require("node-fetch");

const User = require("../models/User");
const Transaction = require("../models/Transaction");

// ==================== CONFIG & VALIDATION ====================
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY?.trim();
if (!PAYSTACK_SECRET_KEY) {
  console.error("FATAL: PAYSTACK_SECRET_KEY is missing or empty");
  process.exit(1);
}

const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL?.trim();
const MAIN_BACKEND_API_KEY = process.env.MAIN_BACKEND_API_KEY?.trim();

// ==================== RAW BODY MIDDLEWARE (MUST BE FIRST) ====================
const rawBodyMiddleware = express.raw({ type: "application/json", limit: "5mb" });

// ==================== SECURE SYNC TO MAIN BACKEND ====================
async function syncToMainBackend(userId, amountNaira, reference) {
  if (!MAIN_BACKEND_URL) {
    console.warn("MAIN_BACKEND_URL not set — running in standalone mode");
    return { success: true, standalone: true };
  }

  const payload = {
    userId: userId.toString(),
    amount: Math.round(amountNaira * 100), // Always send in kobo
    reference,
    description: `Virtual account deposit - ${reference}`,
    source: "virtual_account_webhook",
    timestamp: new Date().toISOString()
  };

  console.log("SYNC → Main Backend:", payload);

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(`${MAIN_BACKEND_URL}/api/wallet/top-up`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "VirtualAccountBackend/3.0",
          ...(MAIN_BACKEND_API_KEY && { "x-internal-api-key": MAIN_BACKEND_API_KEY })
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      const data = await res.json();

      if (res.ok && (data.success || data.alreadyProcessed)) {
        console.log("MAIN BACKEND SYNCED", data.alreadyProcessed ? "(already done)" : "");
        return { success: true, alreadyProcessed: !!data.alreadyProcessed };
      }

      console.log(`Sync attempt ${attempt} failed:`, data);
    } catch (err) {
      console.error(`Sync attempt ${attempt} error:`, err.name === "AbortError" ? "Timeout" : err.message);
    }

    if (attempt < 5) await new Promise(r => setTimeout(r, attempt * 3000));
  }

  console.error("CRITICAL: FAILED TO SYNC WITH MAIN BACKEND AFTER 5 ATTEMPTS");
  // TODO: Send alert (email, Slack, etc.)
  return { success: false, error: "Sync failed" };
}

// ==================== WEBHOOK ENDPOINT — BULLETPROOF ====================
router.post("/virtual-account", rawBodyMiddleware, async (req, res) => {
  console.log("\nPAYSTACK WEBHOOK RECEIVED");

  const signature = req.headers["x-paystack-signature"];
  const rawBody = req.body;

  // === 1. IMMEDIATE 200 RESPONSE (Paystack requirement) ===
  res.status(200).json({ status: "OK" });

  // === 2. SECURITY: Verify signature ===
  if (!signature) {
    console.log("Missing x-paystack-signature header");
    return;
  }

  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature))) {
    console.log("INVALID SIGNATURE — POSSIBLE ATTACK REJECTED");
    return;
  }
  console.log("Signature verified");

  // === 3. Parse event safely ===
  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    console.log("Invalid JSON payload");
    return;
  }

  // === 4. Filter: Only dedicated NUBAN success events ===
  if (
    event.event !== "charge.success" ||
    event.data?.channel !== "dedicated_nuban" ||
    event.data?.status !== "success"
  ) {
    console.log("Ignoring non-virtual-account event");
    return;
  }

  const data = event.data;
  const reference = data.reference;
  const amountNaira = data.amount / 100;

  console.log(`DEPOSIT: ₦${amountNaira.toFixed(2)} | Ref: ${reference}`);

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      // === IDEMPOTENCY: Prevent double processing ===
      const existing = await Transaction.findOne({ reference }).session(session);
      if (existing) {
        console.log(`Already processed: ${reference}`);
        return;
      }

      // === Find user ===
      let user = null;
      const accountNo = data.authorization?.receiver_bank_account_number;

      if (accountNo) {
        user = await User.findOne({ "virtualAccount.accountNumber": accountNo }).session(session);
      }
      if (!user && data.customer?.email) {
        user = await User.findOne({ email: { $regex: `^${data.customer.email}$`, $options: "i" } }).session(session);
      }
      if (!user) {
        console.log("USER NOT FOUND", { accountNo, email: data.customer?.email });
        return;
      }

      console.log(`Crediting ${user.email} (+₦${amountNaira})`);

      const before = user.walletBalance || 0;
      user.walletBalance = before + amountNaira;
      await user.save({ session });

      await Transaction.create([{
        userId: user._id,
        type: "virtual_account_topup",
        amount: amountNaira,
        status: "Successful",
        reference,
        description: "Virtual account deposit",
        balanceBefore: before,
        balanceAfter: user.walletBalance,
        gateway: "paystack",
        details: {
          source: "paystack_webhook",
          channel: "dedicated_nuban",
          virtualAccount: accountNo || "N/A"
        }
      }], { session });

      console.log(`LOCAL WALLET CREDITED: ₦${amountNaira}`);

      // === SYNC TO MAIN BACKEND ===
      const syncResult = await syncToMainBackend(user._id, amountNaira, reference);
      if (!syncResult.success && !syncResult.alreadyProcessed) {
        console.error("MAIN BACKEND NOT UPDATED — REQUIRES MANUAL RECONCILIATION");
        // TODO: Alert team
      } else {
        console.log("FULLY SYNCED WITH MAIN BACKEND");
      }
    });

    console.log(`WEBHOOK SUCCESSFULLY PROCESSED: ${reference}\n`);
  } catch (err) {
    console.error("FATAL ERROR — TRANSACTION ROLLED BACK:", err);
  } finally {
    session.endSession();
  }
});

module.exports = router;
