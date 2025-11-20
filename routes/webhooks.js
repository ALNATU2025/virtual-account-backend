const express = require("express");
const router = express.Router();
const crypto = require("crypto");

const User = require("../models/User");
const VirtualAccount = require("../models/VirtualAccount");
const Transaction = require("../models/Transaction");
const axios = require("axios");

const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL; // e.g. https://vtpass-backend.onrender.com
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// 🛑 Duplicate protection memory
const processedEvents = new Set();

/*
|--------------------------------------------------------------------------
| PAYSTACK WEBHOOK FOR VIRTUAL ACCOUNT
| Endpoint: /api/webhooks
|--------------------------------------------------------------------------
*/
router.post("/", async (req, res) => {
    try {
        console.log("🔔 WEBHOOK RECEIVED:", req.body);

        // 1️⃣ VERIFY PAYSTACK SIGNATURE
        const hash = crypto
            .createHmac("sha512", PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest("hex");

        if (hash !== req.headers["x-paystack-signature"]) {
            console.log("❌ Invalid signature — webhook ignored");
            return res.status(401).send("Invalid signature");
        }

        const event = req.body;

        // 2️⃣ DUPLICATE CHECK
        if (processedEvents.has(event.event)) {
            console.log("⚠️ Duplicate event ignored:", event.event);
            return res.status(200).send("Duplicate ignored");
        }
        processedEvents.add(event.event);

        // 3️⃣ PROCESS ONLY SUCCESSFUL TRANSFERS
        if (event.event !== "transfer.success" && event.event !== "charge.success") {
            console.log("ℹ️ Not a transfer or charge event — ignored");
            return res.status(200).send("Ignored");
        }

        const data = event.data;
        const amountNaira = data.amount / 100; // convert kobo → Naira
        const reference = data.reference;
        const senderName = data.customer?.name || "Unknown Sender";
        const accountNumber = data.metadata?.account_number;

        console.log("📌 Extracted Data:", {
            accountNumber,
            amountNaira,
            reference,
            senderName,
        });

        if (!accountNumber) {
            console.log("❌ Missing virtual account number");
            return res.status(400).send("No account number");
        }

        // 4️⃣ FIND VIRTUAL ACCOUNT OWNER
        const vAccount = await VirtualAccount.findOne({ accountNumber });
        if (!vAccount) {
            console.log("❌ No user found for account:", accountNumber);
            return res.status(404).send("User not found");
        }

        // 5️⃣ GET USER
        const user = await User.findById(vAccount.userId);
        if (!user) {
            console.log("❌ User record missing for virtual account owner");
            return res.status(404).send("User not found");
        }

        // 6️⃣ UPDATE USER BALANCE
        user.balance = (user.balance || 0) + amountNaira;
        await user.save();

        console.log(`💰 Balance Updated: ₦${amountNaira} added to user ${user.fullName}`);

        // 7️⃣ RECORD TRANSACTION
        const transaction = await Transaction.create({
            userId: user._id,
            type: "credit",
            amount: amountNaira,
            status: "successful",
            description: `Deposit from ${senderName}`,
            reference,
        });

        console.log("🧾 Transaction Saved:", transaction);

        // 8️⃣ SYNC WITH MAIN BACKEND (OPTIONAL)
        if (MAIN_BACKEND_URL) {
            try {
                console.log("🌍 Syncing with main backend...");
                await axios.post(`${MAIN_BACKEND_URL}/api/sync/virtual-account`, {
                    userId: user._id,
                    amount: amountNaira,
                    reference,
                });
                console.log("✅ Sync complete");
            } catch (syncErr) {
                console.log("⚠️ Sync error:", syncErr.message);
            }
        }

        return res.status(200).send("Webhook processed");
    } catch (err) {
        console.log("🔥 Webhook Error:", err);
        return res.status(500).send("Server error");
    }
});

module.exports = router;
