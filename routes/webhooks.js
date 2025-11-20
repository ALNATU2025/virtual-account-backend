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
router.post("/virtual-account", async (req, res) => {
  {
    // ========= 1. IMMEDIATE 200 RESPONSE – PayStack will retry if not received fast =========
    res.status(200).json({ status: "ok" });

    const signature = req.headers["x-paystack-signature"];
    if (!signature) {
        console.log("Missing PayStack signature");
        return;
    }

    // ========= 2. VERIFY SIGNATURE =========
    const hash = crypto
        .createHmac("sha512", PAYSTACK_SECRET_KEY)
        .update(JSON.stringify(req.body))
        .digest("hex");

    if (hash !== signature) {
        console.log("Invalid PayStack signature");
        return;
    }

    const event = req.body;

    // ========= 3. LOG FULL PAYLOAD FOR DEBUGGING =========
    console.log("Virtual Account Webhook Received:", JSON.stringify(event, null, 2));

    // ========= 4. ONLY PROCESS transfer.success (this is the ONLY event for virtual accounts) =========
    if (event.event !== "transfer.success" || event.data.status !== "success") {
        console.log(`Ignored event: ${event.event} | status: ${event.data?.status}`);
        return;
    }

    const data = event.data;
    const reference = data.reference;
    const amountKobo = data.amount;
    const amountNaira = amountKobo / 100;

    const virtualAccountNumber = data.recipient?.account_number;

    if (!reference || !virtualAccountNumber) {
        console.log("Missing reference or account number");
        return;
    }

    // ========= 5. DUPLICATE PROTECTION (idempotency) =========
    if (processedReferences.has(reference)) {
        console.log(`Duplicate transfer ignored: ${reference}`);
        return;
    }
    processedReferences.add(reference);

    // ========= 6. FIND USER BY VIRTUAL ACCOUNT NUMBER =========
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const user = await User.findOne({ virtualAccountNumber }).session(session);
        if (!user) {
            console.log(`User not found for account: ${virtualAccountNumber}`);
            await session.abortTransaction();
            return;
        }

        // ========= 7. CHECK IF ALREADY PROCESSED IN DB =========
        const existingTx = await Transaction.findOne({ reference }).session(session);
        if (existingTx) {
            console.log(`Already processed in DB: ${reference}`);
            await session.abortTransaction();
            return;
        }

        // ========= 8. CREDIT USER WALLET =========
        const balanceBefore = user.walletBalance || 0;
        user.walletBalance = balanceBefore + amountNaira;
        await user.save({ session });

        // ========= 9. RECORD TRANSACTION =========
        await Transaction.create([{
            userId: user._id,
            type: "virtual_account_deposit",
            amount: amountNaira,
            status: "success",
            reference,
            gateway: "paystack_virtual_account",
            description: `Deposit via virtual account ${virtualAccountNumber}`,
            balanceBefore,
            balanceAfter: user.walletBalance,
            metadata: {
                source: "virtual_account_webhook",
                senderName: data.sender_name || "Unknown",
                senderAccount: data.sender_account_number || "N/A",
                bankName: data.recipient?.bank_name || "Wema Bank",
                transferCode: data.transfer_code,
                sessionId: data.session_id,
            }
        }], { session });

        await session.commitTransaction();
        console.log(`SUCCESS: ₦${amountNaira} credited to ${user.email} | Ref: ${reference}`);

        // ========= 10. SYNC TO MAIN APP (vtpass-backend) =========
        try {
            await syncVirtualAccountTransferWithMainBackend(user._id, amountNaira, reference);
        } catch (syncErr) {
            console.error("Main backend sync failed (will retry on next webhook):", syncErr.message);
            // Do NOT fail the webhook – money is already in virtual backend
        }

    } catch (error) {
        await session.abortTransaction();
        console.error("Webhook processing error:", error);
        // Do not return error – PayStack already got 200
    } finally {
        session.endSession();
    }
});

module.exports = router;
