// routes/webhooks.js - FINAL & PERFECT VERSION (2025)
// WORKS FOR ALL PAYSTACK PAYMENTS: Card, USSD, Bank, Opay, Apple Pay + Virtual Account

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const Transaction = require("../models/Transaction");
const { syncVirtualAccountTransferWithMainBackend } = require("../utils/syncVirtualAccount");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// Prevent duplicate processing (clears on restart – PayStack retries fast, so it's safe)
const processedReferences = new Set();

// PAYSTACK WEBHOOK - ACCEPTS ALL SUCCESSFUL PAYMENTS
router.post("/virtual-account", async (req, res) => {
  // Immediate response to PayStack
  res.status(200).json({ status: "ok" });

  const signature = req.headers["x-paystack-signature"];
  if (!signature) {
    console.log("Missing PayStack signature");
    return;
  }

  // Verify signature
  const hash = crypto
    .createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (hash !== signature) {
    console.log("Invalid PayStack signature");
    return;
  }

  const event = req.body;
  console.log("PAYSTACK WEBHOOK RECEIVED:", event.event, "| Channel:", event.data.channel || "unknown");

  // ONLY PROCESS SUCCESSFUL CHARGES
  if (event.event !== "charge.success" || event.data.status !== "success") {
    console.log(`Ignored event: ${event.event} | status: ${event.data.status}`);
    return;
  }

  const data = event.data;
  const reference = data.reference;
  const amountKobo = Number(data.amount);
  const amountNaira = amountKobo / 100;

  if (!reference || amountNaira <= 0) {
    console.log("Invalid reference or amount");
    return;
  }

  // Prevent duplicate processing
  if (processedReferences.has(reference)) {
    console.log(`Duplicate webhook ignored: ${reference}`);
    return;
  }
  processedReferences.add(reference);

  // Double-check database
  const existing = await Transaction.findOne({ reference });
  if (existing) {
    console.log(`Already processed in DB: ${reference}`);
    return;
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    let user = null;

    // METHOD 1: Virtual Account Transfer (dedicated_nuban)
    if (data.channel === "dedicated_nuban") {
      const virtualAccountNumber =
        data.authorization?.receiver_bank_account_number ||
        data.metadata?.receiver_account_number ||
        data.recipient?.account_number ||
        data.recipient_account_number;

      if (virtualAccountNumber) {
        user = await User.findOne({ virtualAccountNumber }).session(session);
        console.log(`Found user via virtual account: ${virtualAccountNumber}`);
      }
    }

    // METHOD 2: Card, USSD, Bank Transfer, Opay, Apple Pay, etc.
    if (!user && data.metadata?.userId) {
      user = await User.findById(data.metadata.userId).session(session);
      console.log(`Found user via metadata.userId: ${data.metadata.userId}`);
    }

    // FINAL FALLBACK: Try customer email (rare case)
    if (!user && data.customer?.email) {
      user = await User.findOne({ email: data.customer.email }).session(session);
      console.log(`Found user via customer email: ${data.customer.email}`);
    }

    if (!user) {
      console.log("USER NOT FOUND - Cannot credit wallet");
      await session.abortTransaction();
      return;
    }

    // Update balance
    const balanceBefore = user.walletBalance || 0;
    user.walletBalance = balanceBefore + amountNaira;
    const balanceAfter = user.walletBalance;
    await user.save({ session });

    // Record transaction
    await Transaction.create(
      [{
        userId: user._id,
        type: "wallet_funding",
        amount: amountNaira,
        status: "success",
        reference,
        description: `Funding via ${data.channel || "PayStack"}`,
        balanceBefore,
        balanceAfter,
        gateway: "paystack",
        metadata: {
          source: "paystack_webhook",
          channel: data.channel || "unknown",
          paymentMethod: data.authorization?.card_type || data.channel || "unknown",
          customerEmail: data.customer?.email || "N/A",
          customerName: `${data.customer?.first_name || ""} ${data.customer?.last_name || ""}`.trim() || "N/A",
        },
      }],
      { session }
    );

    await session.commitTransaction();

    console.log(`SUCCESS: ₦${amountNaira} credited to ${user.email} | Method: ${data.channel} | Ref: ${reference}`);

    // Sync to main backend
    try {
      await syncVirtualAccountTransferWithMainBackend(user._id, amountNaira, reference);
      console.log("Main backend sync successful");
    } catch (syncError) {
      console.error("Main backend sync failed (will retry later):", syncError.message);
      // Don't fail the webhook if sync fails — user already got money
    }
  } catch (error) {
    await session.abortTransaction();
    console.error("CRITICAL WEBHOOK ERROR:", error.message);
  } finally {
    session.endSession();
  }
});

module.exports = router;
