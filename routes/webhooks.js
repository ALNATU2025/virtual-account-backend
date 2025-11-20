const express = require("express");
const router = express.Router();
const crypto = require("crypto");

const User = require("../models/User");
const VirtualAccount = require("../models/VirtualAccount");
const Transaction = require("../models/Transaction");
const axios = require("axios");

const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// Proper duplicate protection (reference-based)
const processedEvents = new Set();

/*
|--------------------------------------------------------------------------
| PAYSTACK WEBHOOK — Virtual Account Deposits
| Endpoint: /api/webhooks
|--------------------------------------------------------------------------
*/
router.post("/", async (req, res) => {
    try {
        console.log("🔔 WEBHOOK RECEIVED:", req.body);

        // 1) Verify Paystack signature
        const hash = crypto
            .createHmac("sha512", PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest("hex");

        if (hash !== req.headers["x-paystack-signature"]) {
            console.log("❌ Invalid Paystack signature");
            return res.status(401).send("Invalid signature");
        }

        const event = req.body;
        const data = event.data;

        // 2) Only process actual virtual account credit notifications
        const supportedEvents = ["charge.success", "transfer.complete"];
        if (!supportedEvents.includes(event.event)) {
            console.log("ℹ️ Ignored event:", event.event);
            return res.status(200).send("ignored");
        }

        // 3) Extract fields
        const reference = data.reference;
        const amountNaira = data.amount / 100;

        // Duplicate protection (reference)
        if (processedEvents.has(reference)) {
            console.log("⚠️ DUPLICATE PAYMENT IGNORED:", reference);
            return res.status(200).send("duplicate");
        }
        processedEvents.add(reference);

        // 4) Extract virtual account number
        const accountNumber =
            data?.metadata?.account_number ||
            data?.customer?.bank?.account_number;

        if (!accountNumber) {
            console.log("❌ No virtual account number provided");
            return res.status(400).send("No account number");
        }

        // 5) Find virtual account owner
        const vAcc = await VirtualAccount.findOne({ accountNumber });
        if (!vAcc) {
            console.log("❌ Unknown virtual account:", accountNumber);
            return res.status(404).send("account not found");
        }

        const user = await User.findById(vAcc.userId);
        if (!user) {
            console.log("❌ User not found for VA:", vAcc.userId);
            return res.status(404).send("user not found");
        }

        // 6) Update user balance
        user.balance = (user.balance || 0) + amountNaira;
        await user.save();

        console.log(`💰 ₦${amountNaira} added → ${user.fullName}`);

        // 7) Save transaction
        await Transaction.create({
            userId: user._id,
            type: "credit",
            status: "successful",
            amount: amountNaira,
            reference,
            description: `Virtual account deposit`,
        });

        console.log("🧾 Transaction saved:", reference);

        // 8) Optional sync with main backend
        if (MAIN_BACKEND_URL) {
            try {
                await axios.post(`${MAIN_BACKEND_URL}/api/sync/virtual-account`, {
                    userId: user._id,
                    amount: amountNaira,
                    reference,
                });
                console.log("🌍 Sync successful");
            } catch (syncErr) {
                console.log("⚠️ Sync error →", syncErr.message);
            }
        }

        return res.status(200).send("ok");
    } catch (err) {
        console.log("🔥 Webhook Fatal Error:", err);
        return res.status(500).send("server error");
    }
});

module.exports = router;
