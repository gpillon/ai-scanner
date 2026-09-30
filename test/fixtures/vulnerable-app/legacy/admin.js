// Old admin console, kept for backwards compatibility.
const express = require('express');

const router = express.Router();

router.post('/eval', (req, res) => {
  res.json({ result: eval(req.body.expression) });
});

module.exports = router;
