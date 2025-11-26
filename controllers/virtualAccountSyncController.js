// MAIN BACKEND — controllers/virtualAccountSyncController.js
const mongoose = require("mongoose");
const User = require("../models/User");
const Transaction = require("../models/Transaction");

exports.syncVirtualAccountCredit = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    // Optional internal key
    if (process.env.MAIN_BACKEND_API_KEY && req.headers["x-internal-api-key"] !== process.env.MAIN_BACKEND_API_KEY) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }

    const { userId, amount: amountKobo, reference } = req.body;
    if (!userId || !amountKobo || !reference) return res.status(400).json({ success: false, error: "Missing fields" });

    const amountNaira = Number(amountKobo) / 100;

    await session.startTransaction();

    // IDEMPOTENCY — this is the real money, so we are extra strict
    const existing = await Transaction.findOne({
      reference,
      status: "Successful",
      type: "virtual_account_topup"
    }).session(session);

    if (existing) {
      await session.abortTransaction();
      return res.json({
        success: true,
        alreadyProcessed: true,
        newBalance: existing.balanceAfter,
        message: "Already credited"
      });
    }

    const user = await User.findById(userId).session(session);
    if (!user) { await session.abortTransaction(); return res.status(404).json({ success: false, error: "User not found" }); }

    const before = user.walletBalance;
    user.walletBalance += amountNaira;
    await user.save({ session });

    await Transaction.create([{
      userId: user._id,
      type: "virtual_account_topup",
      amount: amountNaira,
      status: "Successful",
      reference,
      description: "Virtual Account Deposit",
      balanceBefore: before,
      balanceAfter: user.walletBalance,
      gateway: "paystack"
    }], { session });

    await session.commitTransaction();

    console.log(`MAIN BACKEND: ₦${amountNaira} credited → ${user.email} | Ref: ${reference}`);

    res.json({
      success: true,
      newBalance: user.walletBalance,
      amount: amountNaira,
      message: "Wallet credited"
    });

  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error("MAIN BACKEND SYNC ERROR:", err);
    res.status(500).json({ success: false, error: "Sync failed" });
  } finally {
    session.endSession();
  }
};
