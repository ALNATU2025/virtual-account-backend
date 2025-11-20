// utils/syncVirtualAccount.js
const axios = require("axios");

const MAIN_BACKEND_URL = "https://vtpass-backend.onrender.com";  // ← Your main backend
const INTERNAL_API_KEY = process.env.MAIN_BACKEND_API_KEY || "your-secret-key-here";  // Set this in .env

async function syncVirtualAccountTransferWithMainBackend(userId, amountNaira, reference) {
  try {
    const response = await axios.post(
      `${MAIN_BACKEND_URL}/api/wallet/top-up`,
      {
        userId: userId.toString(),
        amount: Math.round(amountNaira * 100), // ← MUST be in kobo!
        reference,
        type: "credit",
        description: `Virtual Account Deposit • ${reference}`,
        source: "virtual_account_automatic",
        gateway: "paystack_virtual_account",
      },
      {
        headers: {
          "Content-Type": "application/json",
          // Remove internal key if you don't have it — normal JWT works fine
        },
        timeout: 12000,
      }
    );

    if (response.data.success) {
      console.log(`SYNC SUCCESS → Main backend credited ₦${amountNaira} | Ref: ${reference}`);
    } else {
      console.warn("Main backend returned failure:", response.data);
    }
  } catch (error) {
    console.error("MAIN BACKEND SYNC FAILED (will retry on next deposit):", 
      error.response?.data || error.message
    );
    // DO NOT throw — money is already safe in virtual-account-backend
  }
}

module.exports = { syncVirtualAccountTransferWithMainBackend };
