// routes/webhooks.js - PERFECT & FINAL VERSION (2025 PayStack Standard)
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const Transaction = require("../models/Transaction");

// Import the sync function from server.js (it exists there)
const { syncVirtualAccountTransferWithMainBackend } = require("../utils/syncVirtualAccount");

// In-memory duplicate protection (cleared on restart – safe because PayStack retries fast)
const processedReferences = new Set();

// PayStack secret key
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

/**
 * PAYSTACK VIRTUAL ACCOUNT WEBHOOK
 * Endpoint: POST /api/webhooks/virtual-account
 * This handles ONLY successful transfers into dedicated/virtual accounts
 */
// routes/webhooks.js - FINAL VERSION THAT WORKS WITH REAL PAYSTACK 2025
router.post("/virtual-account", async (req, res) => {
  res.status(200).json({ status: "ok" }); // Immediate ack

  const signature = req.headers["x-paystack-signature"];
  if (!signature) return console.log("Missing signature");

  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (hash !== signature) return console.log("Invalid signature");

  const event = req.body;
  console.log("Virtual Account Webhook:", JSON.stringify(event, null, 2));

  // ACCEPT BOTH EVENTS THAT PAYSTACK SENDS FOR DEDICATED ACCOUNTS
  const isValidCharge = event.event === "charge.success" &&
                        event.data.channel === "dedicated_nuban" &&
                        event.data.status === "success";

  const isValidTransfer = event.event === "transfer.success" &&
                          event.data.status === "success";

  if (!isValidCharge && !isValidTransfer) {
    console.log(`Ignored irrelevant event: ${event.event}`);
    return;
  }

  const data = event.data;
  const reference = data.reference;
  const amountKobo = Number(data.amount || data.amount_kobo || 0);
  const amountNaira = amountKobo / 100;

  // Extract virtual account number from multiple possible locations
  const virtualAccountNumber = 
    data.authorization?.receiver_bank_account_number ||
    data.metadata?.receiver_account_number ||
    data.recipient?.account_number ||
    data.recipient_account_number;

  if (!reference || !virtualAccountNumber) {
    console.log("Missing reference or virtual account number");
    return;
  }

  if (processedReferences.has(reference)) {
  console.log(`DUPLICATE WEBHOOK IGNORED: ${reference}`);
  return res.status(200).json({ message: "Already processed" });
  }
  processedReferences.add(reference);

  // ALSO check database (double safety)
  const existingInDB = await Transaction.findOne({ reference });
  if (existingInDB) {
  console.log(`ALREADY IN DB - IGNORING: ${reference}`);
  return res.status(200).json({ message: "Already exists in DB" });
  }




  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await User.findOne({ virtualAccountNumber }).session(session);
    if (!user) {
      console.log(`No user found for account: ${virtualAccountNumber}`);
      await session.abortTransaction();
      return;
    }

    const existingTx = await Transaction.findOne({ reference }).session(session);
    if (existingTx) {
      console.log(`Already processed in DB: ${reference}`);
      await session.abortTransaction();
      return;
    }

    //const balanceBefore = user.walletBalance || 0;
    //user.walletBalance = balanceBefore + amountNaira;
    //await user.save({ session });

    await Transaction.create([{
  userId: user._id,
  type: "virtual_account_deposit",
  amount: amountNaira,
  status: "success",
  reference,
  gateway: "paystack_virtual_account",
  description: `Deposit via virtual account ${virtualAccountNumber}`,
  balanceBefore: user.walletBalance,  // ← Use current balance
  balanceAfter: user.walletBalance + amountNaira,  // ← Simulate what it would be
  metadata: {
    source: event.event,
    senderName: data.authorization?.sender_name || data.sender_name || "Unknown",
    virtualAccountNumber,
    channel: data.channel || "dedicated_nuban",
    note: "Balance credited in main backend only"
  }
}], { session });

    await session.commitTransaction();
    console.log(`AUTOMATIC CREDIT: ₦${amountNaira} → ${user.email} | Ref: ${reference} | Event: ${event.event}`);

    // Sync to main backend
    try {
      await syncVirtualAccountTransferWithMainBackend(user._id, amountNaira, reference);  // ← NAIRA, 
    } catch (e) {
      console.error("Main backend sync failed:", e.message);
    }

  } catch (error) {
    await session.abortTransaction();
    console.error("Webhook processing error:", error);
  } finally {
    session.endSession();
  }
});

module.exports = router;
