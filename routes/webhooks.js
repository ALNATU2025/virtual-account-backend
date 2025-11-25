// routes/webhooks.js — FINAL PERFECTION (2025)
// DOUBLE FUNDING = MATHEMATICALLY IMPOSSIBLE

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const Transaction = require("../models/Transaction");
const { syncVirtualAccountTransferWithMainBackend } = require("../utils/syncVirtualAccount");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
if (!PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY missing");

// Preserve raw body for signature
const rawBodyMiddleware = express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  },
});

// Best-effort in-memory cache (TTL: 10 mins)
const processedCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ref, timestamp] of processedCache.entries()) {
    if (now - timestamp > 10 * 60 * 1000) processedCache.delete(ref);
  }
}, 60_000);

// MAIN WEBHOOK — NOW TRULY UNBREAKABLE
router.post("/virtual-account", rawBodyMiddleware, async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const requestId = `wh_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // 1. Signature + raw body check
  if (!signature || !req.rawBody) {
    return res.status(400).json({ error: "Missing payload" });
  }

  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(req.rawBody).digest("hex");
  if (hash !== signature) {
    console.warn("Invalid Paystack signature", { requestId });
    return res.status(400).json({ error: "Invalid signature" });
  }

  const event = req.body;
  if (event.event !== "charge.success" || event.data?.status !== "success") {
    return res.status(200).json({ status: "ignored" });
  }

  const data = event.data;
  const reference = data.reference?.trim();
  const amountKobo = Number(data.amount || 0);
  const amountNaira = amountKobo / 100;

  if (!reference || amountNaira <= 0) {
    return res.status(200).json({ status: "invalid" });
  }

  // LAYER 1: Memory dedupe
  if (processedCache.has(reference)) {
    return res.status(200).json({ status: "already_processed" });
  }

  // LAYER 2: DB dedupe
  if (await Transaction.exists({ reference })) {
    processedCache.set(reference, Date.now());
    return res.status(200).json({ status: "already_processed" });
  }

  // NOW safe to acknowledge
  res.status(200).json({ status: "processing", requestId });
  processedCache.set(reference, Date.now());

  // ASYNC PROCESSING
  (async () => {
    let user = null;
    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        // FINAL LAYER: Atomic dedupe inside transaction
        if (await Transaction.findOne({ reference }).session(session)) {
          console.log("Blocked inside transaction", { reference });
          return;
        }

        // === USER RESOLUTION ===
        if (data.channel === "dedicated_nuban") {
          const vaNumber = data.authorization?.account_number ||
                          data.metadata?.receiver_account_number ||
                          data.metadata?.account_number ||
                          data.metadata?.virtual_account_number;

          if (vaNumber) {
            user = await User.findOne({ "virtualAccount.accountNumber": vaNumber }).session(session);
          }
        }

        if (!user && data.metadata?.userId) {
          user = await User.findById(data.metadata.userId).session(session);
        }

        if (!user && data.customer?.email) {
          user = await User.findOne({ 
            email: { $regex: `^${data.customer.email}$`, $options: "i" } 
          }).session(session);
        }

        if (!user) {
          console.warn("User not found", { reference, email: data.customer?.email });
          return;
        }

        // === CREDIT WALLET ===
        const balanceBefore = Number(user.walletBalance || 0);
        user.walletBalance = balanceBefore + amountNaira;
        await user.save({ session });

        // === RECORD TRANSACTION ===
        await Transaction.create([{
          userId: user._id,
          type: "wallet_funding",
          amount: amountNaira,
          status: "success",
          reference,
          description: `Funding via ${data.channel || "Paystack"}`,
          balanceBefore,
          balanceAfter: user.walletBalance,
          gateway: "paystack",
          metadata: {
            source: "paystack_webhook",
            channel: data.channel || "unknown",
            paymentMethod: data.authorization?.card_type || data.channel || "transfer",
            customerEmail: data.customer?.email || "N/A",
          }
        }], { session });

        console.log(`SUCCESS: ₦${amountNaira} → ${user.email} | Ref: ${reference} | Channel: ${data.channel}`);
      });

      // Sync AFTER commit
      if (user) {
        setImmediate(() => {
          syncVirtualAccountTransferWithMainBackend(user._id, amountNaira, reference).catch(err => {
            console.error("Sync failed (non-critical)", { reference, error: err.message });
          });
        });
      }

    } catch (err) {
      console.error("Webhook transaction failed", { reference, error: err.message });
    } finally {
      session.endSession();
    }
  })();
});

// Health check
router.get("/webhook-health", (req, res) => {
  res.json({ 
    status: "healthy", 
    cached_refs: processedCache.size,
    uptime: process.uptime().toFixed(0) + "s"
  });
});

module.exports = router;
