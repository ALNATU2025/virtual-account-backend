// routes/webhooks.js - FINAL PRODUCTION VERSION WITH AMAZING LOGS (2025)
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const net = require("net"); // For CIDR checking

const User = require("../models/User");
const Transaction = require("../models/Transaction");
const { syncVirtualAccountTransferWithMainBackend } = require("../utils/syncVirtualAccount");

// ===================== CONFIG =====================
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
if (!PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY missing");

// Official Paystack IPs + YOUR custom testing IPs
const ALLOWED_IPS = [
  "52.31.139.75",
  "52.49.173.169",
  "52.214.14.220",
  "52.30.107.86",
  "52.51.68.183",
  "52.214.218.189",
  "74.220.48.240",           // ← Your custom IP
];

// CIDR range for your testing (e.g. ngrok, local tunnel)
const ALLOWED_CIDR = ["74.220.56.0/24"];

// In-memory processed events (use Redis in real prod
const processedEvents = new Set();

// Helper: Check if IP is in CIDR range
function isIpInCidr(ip, cidr) {
  const [range, bits] = cidr.split("/");
  const mask = ~(2 ** (32 - bits) - 1);
  const ipNum = ip.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
  const rangeNum = range.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

// ===================== LOGGING UTILS =====================
const log = {
  info: (msg, meta) => console.log(`INFO  ${new Date().toISOString()} | ${msg}`, meta || ""),
  success: (msg, meta) => console.log(`SUCCESS ${new Date().toISOString()} | ${msg}`, meta || ""),
  warn: (msg, meta) => console.log(`WARN  ${new Date().toISOString()} | ${msg}`, meta || ""),
  error: (msg, meta) => console.log(`ERROR ${new Date().toISOString()} | ${msg}`, meta || ""),
  debug: (msg, meta) => console.log(`DEBUG ${new Date().toISOString()} | ${msg}`, meta || ""),
};

// ===================== MAIN WEBHOOK =====================
router.post(
  "/paystack",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const ip = (req.ip || req.connection.remoteAddress || "").replace("::ffff:", "");
    const signature = req.headers["x-paystack-signature"]?.toString();
    const eventId = req.headers["x-paystack-event-id"] || "unknown";

    log.info("PAYSTACK WEBHOOK HIT", { ip, eventId, path: "/webhook/paystack" });

    // === 1. IP WHITELISTING ===
    const isAllowedIp = ALLOWED_IPS.includes(ip) || ALLOWED_CIDR.some(cidr => isIpInCidr(ip, cidr));

    if (!isAllowedIp) {
      log.error("BLOCKED: Unauthorized IP", { ip, allowed: [...ALLOWED_IPS, ...ALLOWED_CIDR] });
      return res.status(401).send("Unauthorized IP");
    }

    log.success("IP allowed", { ip });

    // === 2. SIGNATURE VERIFICATION ===
    if (!signature) {
      log.warn("Missing x-paystack-signature header");
      return res.status(400).send("No signature");
    }

    const computedHash = crypto
      .createHmac("sha512", PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest("hex");

    log.debug("Signature check", {
      received: signature.substring(0, 20) + "...",
      computed: computedHash.substring(0, 20) + "...",
      match: computedHash === signature ? "YES" : "NO",
    });

    if (computedHash !== signature) {
      log.error("INVALID SIGNATURE - POSSIBLE ATTACK", {
        received: signature,
        computed: computedHash,
        ip,
      });
      return res.status(400).send("Invalid signature");
    }

    log.success("Signature verified");

    // === 3. PARSE EVENT ===
    let event;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch (err) {
      log.error("Failed to parse JSON payload", { error: err.message });
      return res.status(400).send("Invalid JSON");
    }

    // === 4. IDEMPOTENCY CHECK ===
    if (processedEvents.has(event.id || event.event_id)) {
      log.warn("Duplicate event ignored", { eventId: event.id, type: event.event });
      return res.status(200).send("OK");
    }

    log.info("New event received", {
      event: event.event,
      reference: event.data?.reference,
      amount: event.data?.amount ? `${event.data.amount / 100} NGN` : "N/A",
      customer: event.data?.customer?.email || "N/A",
    });

    // === 5. HANDLE ONLY VIRTUAL ACCOUNT TOPUPS ===
    if (event.event === "charge.success" && event.data.channel === "dedicated_nuban") {
      // Fire and forget — we already returned 200 soon
      handleVirtualAccountTopup(event.data, event.id)
        .then(() => log.success("Payment fully processed & synced"))
        .catch(err => log.error("Background processing failed", { error: err.message }));
    } else {
      log.info("Event ignored (not a virtual account topup)", { event: event.event, channel: event.data?.channel });
    }

    // Mark as processed & acknowledge immediately
    processedEvents.add(event.id || event.event_id);
    return res.status(200).send("OK");
  }
);

// ===================== BACKGROUND PROCESSOR =====================
async function handleVirtualAccountTopup(data, eventId) {
  const reference = data.reference;
  const amountNaira = Number(data.amount) / 100;

  log.info("Starting wallet credit", {
    reference,
    amount: `₦${amountNaira}`,
    accountNumber: data.authorization?.receiver_bank_account_number,
    email: data.customer?.email,
    eventId,
  });

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      // Duplicate check
      const exists = await Transaction.findOne({ reference }).session(session);
      if (exists) {
        log.warn("Already processed (DB check)", { reference });
        return;
      }

      const user = await findUser(data, session);
      if (!user) {
        log.error("USER NOT FOUND - CANNOT CREDIT", {
          reference,
          accountNumber: data.authorization?.receiver_bank_account_number,
          email: data.customer?.email,
          metadataUserId: data.metadata?.userId,
        });
        return;
      }

      log.success("User matched", { userId: user._id, email: user.email });

      const before = user.walletBalance;
      user.walletBalance += amountNaira;
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
          eventId,
          channel: "dedicated_nuban",
          virtualAccount: data.authorization.receiver_bank_account_number,
          bank: data.authorization.bank,
          paidAt: data.paid_at,
          signatureVerified: true,
        },
      }], { session });

      log.success("WALLET CREDITED", {
        user: user.email,
        credited: `₦${amountNaira}`,
        newBalance: `₦${user.walletBalance}`,
        reference,
      });

      // Sync to main backend
      await syncVirtualAccountTransferWithMainBackend(user._id, amountNaira, reference);
      log.success("Synced to main backend", { reference });
    });
  } catch (err) {
    log.error("Transaction failed (rolled back)", { reference, error: err.message });
  } finally {
    session.endSession();
  }
}

async function findUser(data, session) {
  const acc = data.authorization?.receiver_bank_account_number;

  if (acc) {
    const user = await User.findOne({ "virtualAccount.accountNumber": acc }).session(session);
    if (user) return user;
  }

  if (data.metadata?.userId) {
    const user = await User.findById(data.metadata.userId).session(session);
    if (user) return user;
  }

  if (data.customer?.email) {
    return await User.findOne({ email: data.customer.email.toLowerCase() }).session(session);
  }

  return null;
}

module.exports = router;
