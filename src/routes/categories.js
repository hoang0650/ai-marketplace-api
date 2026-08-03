const express = require('express');
const { CATEGORY_META } = require('../data/categories');

const router = express.Router();

router.get('/', (_req, res) => {
  res.json(CATEGORY_META);
});

module.exports = router;
