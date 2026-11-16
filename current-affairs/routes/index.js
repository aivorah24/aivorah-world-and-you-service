const express = require('express');

const router = express.Router();

router.use('/digest', require('./digest'));
router.use('/story', require('./story'));
router.use('/quiz', require('./quiz'));
router.use('/progress', require('./progress'));
router.use('/admin', require('./admin'));
router.use('/pipeline', require('./pipeline'));
router.use('/gk', require('./gk-facts'));

module.exports = router;
