const express = require('express');
const { db } = require('../db');

const router = express.Router();

// GET /api/notifications - latest 30 + unread count
router.get('/', (req, res) => {
  const items = db.prepare(
    'SELECT id, message, project_id, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30'
  ).all(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id).n;
  res.json({ items, unread });
});

// POST /api/notifications/read - mark all as read
router.post('/read', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;