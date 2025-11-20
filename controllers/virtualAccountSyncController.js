// controllers/virtualAccountSyncController.js
const User = require("../models/User");
const Transaction = require("../models/Transaction");

exports.syncVirtualAccountCredit = async (req, res) => {
  try {
    const internalKey = req.headers["x-internal-api-key"];
    if (!internalKey || internalKey !== process.env.MAIN_BACKEND_API_KEY) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const { userId, amount, reference } = req.body;
    if (!userId || !amount || !reference) return res.status(400).json({ error: "Missing fields" });

    const existing = await Transaction.findOne({ reference });
    if (existing) return res.status(200).json({ message: "Already synced" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const before = user.walletBalance || 0;
    user.walletBalance += amount;
    await user.save();

    await Transaction.create({
      userId,
      amount,
      reference,
      type: "virtual_account_topup",
      gateway: "paystack",
      status: "success",
      description: "Virtual account auto-credit",
      balanceBefore: before,
      balanceAfter: user.walletBalance
    });

    return res.json({ success: true, newBalance: user.walletBalance });

  } catch (err) {
    console.error("SYNC ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
};
