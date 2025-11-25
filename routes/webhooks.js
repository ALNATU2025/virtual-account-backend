// routes/webhooks.js - PRODUCTION-READY PAYSTACK WEBHOOK (2025 BEST PRACTICES)
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

// Models
const User = require("../models/User");
const Transaction = require("../models/Transaction");

// Utils
const { syncVirtualAccountTransferWithMainBackend } = require("../utils/syncVirtualAccount");

// Config
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
if (!PAYSTACK_SECRET_KEY) {
  throw new Error("PAYSTACK_SECRET_KEY is not set in environment variables");
}

// Paystack IPs (2025 updated list - always verify: https://paystack.com/docs/#webhooks-security)
const PAYSTACK_IPS = [
  "52.31.139.75",
  "52.49.173.169",
  "52.214.14.220",
  "52.30.107.86",
  "52.51.68.183",
  "52.214.218.189",
];

// In-memory set to track processed event IDs (use an external store like Redis in high-traffic apps
const processedEventIds = new Set();

// ================ MAIN WEBHOOK ENDPOINT ================
router.post(
  "/paystack",
  express.raw({ type: "application/json" }), // CRITICAL: Must come BEFORE any express.json()
  async (req, res) => {
    const signature = req.headers["x-paystack-signature"];
    const ip = req.ip || req.connection.remoteAddress;

    console.log("Paystack webhook received", {
      ip,
      eventId: req.headers["x-paystack-event-id"],
      timestamp: new Date().toISOString(),
    });

    // === 1. IP Whitelisting (Recommended by Paystack) ===
    if (!PAYSTACK_IPS.includes(ip.replace("::ffff:", ""))) {
      console.warn("Unauthorized webhook IP:", ip);
      return res.status(401).send("Unauthorized IP");
    }

    // === 2. Verify Signature Verification ===
    if (!signature) {
      console.warn("Missing x-paystack-signature header");
      return res.status(400).send("Missing signature");
    }

    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET_KEY)
      .update(req.body) // req.body is Buffer thanks to express.raw()
      .digest("hex");

    if (hash !== signature) {
      console.error("Invalid Paystack signature", { received: signature, computed: hash });
      return res.status(400).send("Invalid signature");
    }

    // === 3. Parse Event Safely ===
    let event;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch (err) {
      console.error("Invalid JSON payload from Paystack");
      return res.status(400).send("Invalid JSON");
    }

    // === 4. Prevent Duplicate Processing (Idempotency) ===
    const eventId = event.id || event.event_id;
    if (!eventId) {
      console.warn("Event missing ID", event.event);
      return res.status(400).send("Missing event ID");
    }

    if (processedEventIds.has(eventId)) {
      console.log(`Duplicate event ignored: ${eventId}`);
      return res.status(200).send("OK");
    }

    // Only process relevant events
    if (event.event === "charge.success") {
      // Queue long-running task
      handleChargeSuccess(event.data).catch((err) => {
        console.error("Unhandled error in handleChargeSuccess:", err);
      });
    }
    // You can add more events later: transfer.success, etc.

    // Mark as processed BEFORE returning 200 (prevents retry loops)
    processedEventIds.add(eventId);

    // Clean up old IDs occasionally (optional)
    if (processedEventIds.size > 10000) {
      // Keep last 5000 only
      const entries = Array.from(processedEventIds).slice(-5000);
      processedEventIds.clear();
      entries.forEach((id) => processedEventIds.add(id));
    }

    // === 5. Acknowledge immediately ===
    return res.status(200).send("OK");
  }
);

// ================ EVENT HANDLERS ================

async function handleChargeSuccess(data) {
  const reference = data.reference;
  const amountKobo = Number(data.amount);
  const amountNaira = amountKobo / 100;

  // Only process dedicated virtual account payments
  if (data.channel !== "dedicated_nuban") {
    console.log(`Ignoring non-virtual-account charge: ${reference} (${data.channel})`);
    return;
  }

  if (data.status !== "success") {
    console.log(`Ignoring non-success charge: ${reference}`);
    return;
  }

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      // Prevent double processing
      const existingTx = await Transaction.findOne({ reference }).session(session);
      if (existingTx) {
        console.log(`Already processed: ${reference}`);
        return;
      }

      const user = await findUserByVirtualAccount(data, session);
      if (!user) {
        console.error("User not found for virtual account payment", {
          reference,
          accountNumber: data.authorization?.receiver_bank_account_number,
          email: data.customer?.email,
          metadataUserId: data.metadata?.userId,
        });
        return;
      }

      const balanceBefore = user.walletBalance;
      user.walletBalance += amountNaira;
      await user.save({ session });

      await Transaction.create(
        [
          {
            userId: user._id,
            type: "virtual_account_topup",
            amount: amountNaira,
            status: "Successful",
            reference,
            description: "Virtual account deposit via Paystack",
            balanceBefore,
            balanceAfter: user.walletBalance,
            gateway: "paystack",
            details: {
              source: "paystack_webhook",
              channel: data.channel,
              paymentMethod: data.authorization?.channel || "dedicated_nuban",
              customerEmail: data.customer?.email || user.email,
              bank: data.authorization?.bank || "N/A",
              virtualAccount: data.authorization?.receiver_bank_account_number,
              paidAt: data.paid_at || new Date(),
              eventId: data.id,
            },
          },
        ],
        { session }
      );

      console.log(`PAYMENT CREDITED: ₦${amountNaira} → ${user.email} | Ref: ${reference}`);

      // Sync to main backend (fire and forget)
      syncVirtualAccountTransferWithMainBackend(user._id, amountNaira, reference).catch((err) =>
        console.error("Main backend sync failed:", err.message)
      );
    });
  } catch (error) {
    console.error("Transaction failed for reference:", reference, error);
    // Do NOT throw — we already returned 200 OK to Paystack
  } finally {
    await session.endSession();
  }
}

async function findUserByVirtualAccount(data, session) {
  const accountNumber = data.authorization?.receiver_bank_account_number;

  if (accountNumber) {
    const user = await User.findOne({
      "virtualAccount.accountNumber": accountNumber,
    }).session(session);

    if (user) return user;
  }

  // Fallback: metadata.userId (if you pass it during initialization)
  if (data.metadata?.userId) {
    return await User.findById(data.metadata.userId).session(session);
  }

  // Fallback: customer email
  if (data.customer?.email) {
    return await User.findOne({ email: data.customer.email.toLowerCase() }).session(session);
  }

  return null;
}

// ================ HEALTH CHECK (Optional) ================
router.get("/paystack/health", (req, res) => {
  res.status(200).json({ status: "ok", time: new Date().toISOString() });
});

module.exports = router;
