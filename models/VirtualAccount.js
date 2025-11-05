// TEMPORARY FIX: Update your VirtualAccount model
const virtualAccountSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        unique: true
    },
    accountNumber: {
        type: String,
        required: true,
        unique: true
    },
    accountName: {
        type: String,
        required: true
    },
    bankName: {
        type: String,
        required: true
    },
    bankCode: {
        type: String,
        required: true
    },
    customerCode: {
        type: String,
        required: true
    },
    assigned: {
        type: Boolean,
        default: true
    },
    active: {
        type: Boolean,
        default: true
    },
    paystackReference: {
        type: String,
        required: false // ✅ TEMPORARY: Change to false
    }
}, {
    timestamps: true
});
