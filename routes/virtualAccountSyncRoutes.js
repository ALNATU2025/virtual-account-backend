const express = require("express");
const router = express.Router();
const { syncVirtualAccountCredit } = require("../controllers/virtualAccountSyncController");

router.post("/virtual-account/sync", syncVirtualAccountCredit);

module.exports = router;
