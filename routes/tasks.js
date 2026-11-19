const express = require('express');
const { db, getMember, findMemberByName } = require('../db');
const { notifyUser, broadcastProject } = require('../realtime');

const router = express.Router();
const STATUSES = ['todo', 'doing', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];
const LABELS = { todo: 'To Do', doing: 'In Progress', done: 'Done' };

// Loads a task and makes sure the logged-in user belongs to its project
function guard(req, res) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!task) { res.status(404).json({ error: 'Task not found.' }); return null; }
  const member = getMember(task.project_id, req.user.id);
  if (!member) { res.status(403).json({ error: 'You are not a member of this project.' }); return null; }
  task.myRole = member.role;
  return task;
}

// PUT /api/tasks/:id - edit, assign, or move a task (send only the fields that change)
router.put('/:id', (req, res) => {
  const t = guard(req, res);
  if (!t) return;
  const b = req.body;

  const title = b.title !== undefined ? String(b.title).trim() : t.title;
  const description = b.description !== undefined ? String(b.description).trim() : t.description;
  if (!title || title.length > 100) return res.status(400).json({ error: 'Task title must be 1-100 characters.' });
  if (description.length > 1000) return res.status(400).json({ error: 'Description must be 1000 characters or less.' });

  let status = t.status;
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'Invalid status.' });
    status = b.status;
  }
  let priority = t.priority;
  if (b.priority !== undefined) {
    if (!PRIORITIES.includes(b.priority)) return res.status(400).json({ error: 'Invalid priority.' });
    priority = b.priority;
  }
  let assigneeId = t.assignee_id;
  if (b.assignee !== undefined) {
    if (!b.assignee) assigneeId = null;
    else {
      const a = findMemberByName(t.project_id, String(b.assignee));
      if (!a) return res.status(400).json({ error: 'Assignee must be a project member.' });
      assigneeId = a.id;
    }
  }

  db.prepare('UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, assignee_id = ? WHERE id = ?')
    .run(title, description, status, priority, assigneeId, t.id);

  const who = req.user.username;
  if (assigneeId && assigneeId !== t.assignee_id && assigneeId !== req.user.id)
    notifyUser(assigneeId, `${who} assigned you "${title}"`, t.project_id);
  else if (status !== t.status && assigneeId && assigneeId !== req.user.id)
    notifyUser(assigneeId, `${who} moved "${title}" to ${LABELS[status]}`, t.project_id);

  broadcastProject(t.project_id);
  res.json({ ok: true });
});

// DELETE /api/tasks/:id (project owner or the task's creator)
router.delete('/:id', (req, res) => {
  const t = guard(req, res);
  if (!t) return;
  if (t.myRole !== 'owner' && t.created_by !== req.user.id)
    return res.status(403).json({ error: 'Only the project owner or the task creator can delete it.' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
  broadcastProject(t.project_id);
  res.json({ ok: true });
});

// GET /api/tasks/:id/comments
router.get('/:id/comments', (req, res) => {
  const t = guard(req, res);
  if (!t) return;
  const comments = db.prepare(`
    SELECT c.id, c.content, c.created_at, u.username
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.task_id = ? ORDER BY c.id
  `).all(t.id);
  res.json(comments);
});

// POST /api/tasks/:id/comments
router.post('/:id/comments', (req, res) => {
  const t = guard(req, res);
  if (!t) return;
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Comment cannot be empty.' });
  if (content.length > 300) return res.status(400).json({ error: 'Comment must be 300 characters or less.' });

  const info = db.prepare('INSERT INTO comments (task_id, user_id, content) VALUES (?, ?, ?)').run(t.id, req.user.id, content);
  const comment = db.prepare(`
    SELECT c.id, c.content, c.created_at, u.username
    FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?
  `).get(info.lastInsertRowid);

  // Tell the assignee and the creator (not the person who commented)
  const targets = new Set([t.assignee_id, t.created_by]);
  targets.delete(req.user.id);
  targets.delete(null);
  for (const uid of targets) notifyUser(uid, `${req.user.username} commented on "${t.title}"`, t.project_id);

  broadcastProject(t.project_id);
  res.status(201).json(comment);
});

module.exports = router;