// routes/webhooks.js - FINAL UNIVERSAL VERSION
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const Transaction = require("../models/Transaction");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY?.trim();
if (!PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY missing");

const processedWebhooks = new Set();

const handlePayStackWebhook = async (req, res) => {
  const webhookId = `wh_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  console.log(`\nPAYSTACK WEBHOOK [${webhookId}]`);
  console.log("Full payload:", JSON.stringify(req.body, null, 2));

  res.status(200).json({ status: "OK", received: true });

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

  let event;
  try {
    event = JSON.parse(req.rawBody.toString());
  } catch (err) {
    console.log("Invalid JSON");
    return;
  }

  if (event.event !== "charge.success" || event.data?.status !== "success") {
    console.log(`Ignored: ${event.event} | Status: ${event.data?.status}`);
    return;
  }

  const data = event.data;
  const reference = data.reference;
  const amountNaira = data.amount / 100;
  const channel = data.channel || "unknown";
  const accountNumber = data.authorization?.receiver_bank_account_number;

  console.log(`PAYMENT SUCCESS`);
  console.log(`Amount: ₦${amountNaira}`);
  console.log(`Reference: ${reference}`);
  console.log(`Channel: ${channel}`);
  console.log(`Virtual Account: ${accountNumber || 'None'}`);
  console.log(`User ID: ${data.metadata?.userId}`);
  console.log(`Email: ${data.customer?.email}`);

  const key = `${reference}_${data.id}`;
  if (processedWebhooks.has(key)) {
    console.log("Duplicate ignored");
    return;
  }
  processedWebhooks.add(key);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const existingTx = await Transaction.findOne({ 
        reference, 
        status: "Successful" 
      }).session(session);

      if (existingTx) {
        console.log("Already credited");
        return;
      }

      let user = null;

      if (data.metadata?.userId) {
        user = await User.findById(data.metadata.userId).session(session);
        console.log("Found by userId:", data.metadata.userId);
      }

      if (!user && data.customer?.email) {
        user = await User.findOne({ email: data.customer.email.toLowerCase().trim() }).session(session);
        console.log("Found by email:", data.customer.email);
      }

      if (!user && accountNumber) {
        user = await User.findOne({ "virtualAccount.accountNumber": accountNumber }).session(session);
        console.log("Found by virtual account:", accountNumber);
      }

      if (!user) {
        console.log("USER NOT FOUND");
        return;
      }

      const before = user.walletBalance || 0;
      user.walletBalance = before + amountNaira;
      await user.save({ session });

      await Transaction.create([{
        userId: user._id,
        type: "Wallet Funding",
        amount: amountNaira,
        reference,
        status: "Successful",
        balanceBefore: before,
        balanceAfter: user.walletBalance,
        gateway: "paystack",
        gatewayResponse: data,
        description: accountNumber ? "Virtual account deposit" : `PayStack ${channel}`,
        metadata: { channel, paystackData: data, webhookId }
      }], { session });

      console.log(`CREDITED +₦${amountNaira} → ${user.email}`);
      console.log(`NEW BALANCE: ₦${user.walletBalance}`);
    });
  } catch (error) {
    console.error("TRANSACTION FAILED:", error.message);
    processedWebhooks.delete(key);
  } finally {
    await session.endSession();
  }
}; // ← THIS CLOSING BRACKET WAS MISSING!

// BOTH ENDPOINTS USE THE SAME HANDLER
router.post("/paystack", handlePayStackWebhook);
router.post("/virtual-account", handlePayStackWebhook);

module.exports = router;
