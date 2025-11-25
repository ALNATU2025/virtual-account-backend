// utils/syncVirtualAccount.js
const axios = require('axios');

const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'https://vtpass-backend.onrender.com';
const MAIN_BACKEND_API_KEY = process.env.MAIN_BACKEND_API_KEY;

async function syncVirtualAccountTransferWithMainBackend(userId, amountInNaira, reference) {
  console.log(`\n🔄 SYNC STARTED:`);
  console.log(`   User: ${userId}`);
  console.log(`   Amount: ₦${amountInNaira}`);
  console.log(`   Reference: ${reference}`);
  console.log(`   Target: ${MAIN_BACKEND_URL}/api/wallet/top-up`);

  if (!MAIN_BACKEND_URL) {
    console.log('❌ MAIN_BACKEND_URL not configured');
    return { success: false, error: 'MAIN_BACKEND_URL not configured' };
  }

  const payload = {
    userId: userId.toString(),
    amount: Math.round(amountInNaira * 100), // Convert to kobo
    reference: reference,
    description: `Virtual account deposit - ${reference}`,
    source: 'virtual_account_webhook'
  };

  console.log('📦 Sync payload:', payload);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`\n🔄 Sync attempt ${attempt}/3...`);
      
      const response = await axios.post(
        `${MAIN_BACKEND_URL}/api/wallet/top-up`,
        payload,
        {
          timeout: 15000,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'VirtualAccountBackend/1.0',
            ...(MAIN_BACKEND_API_KEY && { 'x-internal-api-key': MAIN_BACKEND_API_KEY })
          }
        }
      );

      console.log(`✅ SYNC SUCCESS:`, response.data);
      return { success: true, data: response.data };

    } catch (error) {
      console.error(`❌ Sync attempt ${attempt} failed:`, {
        status: error.response?.status,
        statusText: error.response?.statusText,
        message: error.response?.data?.message || error.message,
        data: error.response?.data
      });

      if (attempt === 3) {
        console.error('💥 ALL SYNC ATTEMPTS FAILED');
        return { 
          success: false, 
          error: error.message,
          response: error.response?.data 
        };
      }

      // Wait before retry
      const delay = attempt * 2000;
      console.log(`⏳ Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

module.exports = { syncVirtualAccountTransferWithMainBackend };
