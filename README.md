HOW TO INTEGRATE WITH YOUR EXISTING BACKEND:

1. COPY FILES:
   - Copy models/VirtualAccount.js to your existing models folder
   - Copy routes/virtualAccount.js to your existing routes folder

2. UPDATE MAIN SERVER FILE (app.js or server.js):
   Add these lines:

   const virtualAccountRoutes = require('./routes/virtualAccount');
   app.use('/api/virtual-account', virtualAccountRoutes);

3. INSTALL DEPENDENCIES (if not already installed):
   npm install axios

4. ENVIRONMENT VARIABLES:
   Make sure you have in your .env file:
   PAYSTACK_SECRET_KEY=sk_test_your_secret_key_here

5. PAYSTACK WEBHOOK SETUP:
   In Paystack dashboard, set webhook URL to:
   https://your-backend.com/api/virtual-account/webhook

6. UPDATE YOUR EXISTING MODELS:
   Make sure you have User and Transaction models with these fields:
   - User: walletBalance (Number)
   - Transaction: userId, amount, type, description, status, reference, balanceAfter

7. FLUTTER INTEGRATION:
   Use the PaymentService methods provided in the previous response.
