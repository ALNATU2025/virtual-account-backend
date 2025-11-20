// utils/syncVirtualAccount.js
const axios = require("axios");

async function syncVirtualAccountTransferWithMainBackend(userId, amount, reference) {
  try {
    const url = `${process.env.MAIN_BACKEND_URL}/virtual-account/sync`;
    const payload = { userId, amount, reference };

    await axios.post(url, payload, {
      headers: {
        "x-internal-api-key": process.env.MAIN_BACKEND_API_KEY
      },
      timeout: 10000
    });

    console.log("✅ Synced to MAIN_BACKEND:", url, reference);
  } catch (err) {
    console.error("⚠️ Sync failed:", err?.response?.data || err.message);
    throw err; // let caller decide (we already credit local wallet first)
  }
}

module.exports = { syncVirtualAccountTransferWithMainBackend };
