const express = require('express');
const { db, getMember, findMemberByName, memberIds } = require('../db');
const { notifyUser, broadcastProject, sendTo } = require('../realtime');

const router = express.Router();
const STATUSES = ['todo', 'doing', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];

const TASKS_SQL = `
  SELECT t.id, t.title, t.description, t.status, t.priority, t.created_at,
         a.username AS assignee, c.username AS creator,
         (SELECT COUNT(*) FROM comments cm WHERE cm.task_id = t.id) AS comment_count
  FROM tasks t
  LEFT JOIN users a ON a.id = t.assignee_id
  JOIN users c ON c.id = t.created_by
  WHERE t.project_id = ?
  ORDER BY t.id`;

// GET /api/projects - projects I belong to, with progress numbers
router.get('/', (req, res) => {
  const projects = db.prepare(`
    SELECT p.id, p.name, p.description, u.username AS owner,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count,
      (SELECT COUNT(*) FROM project_members m2 WHERE m2.project_id = p.id) AS member_count
    FROM projects p
    JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
    JOIN users u ON u.id = p.owner_id
    ORDER BY p.id DESC
  `).all(req.user.id);
  res.json(projects);
});

// POST /api/projects - create a group project (creator becomes owner)
router.post('/', (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  if (!name || name.length > 60) return res.status(400).json({ error: 'Project name must be 1-60 characters.' });
  if (description.length > 200) return res.status(400).json({ error: 'Description must be 200 characters or less.' });

  const info = db.prepare('INSERT INTO projects (name, description, owner_id) VALUES (?, ?, ?)').run(name, description, req.user.id);
  db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')").run(info.lastInsertRowid, req.user.id);
  res.status(201).json({ id: info.lastInsertRowid });
});

// GET /api/projects/:id - the whole board (project, members, tasks)
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const project = db.prepare('SELECT p.id, p.name, p.description, u.username AS owner FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  const me = getMember(id, req.user.id);
  if (!me) return res.status(403).json({ error: 'You are not a member of this project.' });

  const members = db.prepare(`
    SELECT u.username, m.role FROM project_members m
    JOIN users u ON u.id = m.user_id WHERE m.project_id = ?
    ORDER BY m.role DESC, u.username
  `).all(id);

  res.json({ ...project, is_owner: me.role === 'owner', members, tasks: db.prepare(TASKS_SQL).all(id) });
});

// DELETE /api/projects/:id (owner only)
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const me = getMember(id, req.user.id);
  if (!me) return res.status(404).json({ error: 'Project not found.' });
  if (me.role !== 'owner') return res.status(403).json({ error: 'Only the owner can delete a project.' });

  const ids = memberIds(id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  sendTo(ids, { type: 'project', projectId: id });
  res.json({ ok: true });
});

// POST /api/projects/:id/members { username } (owner only)
router.post('/:id/members', (req, res) => {
  const id = Number(req.params.id);
  const me = getMember(id, req.user.id);
  if (!me) return res.status(404).json({ error: 'Project not found.' });
  if (me.role !== 'owner') return res.status(403).json({ error: 'Only the owner can add members.' });

  const username = String(req.body.username || '').trim();
  const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
  if (!user) return res.status(404).json({ error: 'No user with that username.' });
  if (getMember(id, user.id)) return res.status(409).json({ error: `${user.username} is already a member.` });

  db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'member')").run(id, user.id);
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(id);
  notifyUser(user.id, `${req.user.username} added you to "${project.name}"`, id);
  broadcastProject(id);
  res.status(201).json({ username: user.username });
});

// POST /api/projects/:id/tasks - create a task card
router.post('/:id/tasks', (req, res) => {
  const id = Number(req.params.id);
  if (!getMember(id, req.user.id)) return res.status(403).json({ error: 'You are not a member of this project.' });

  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  const status = STATUSES.includes(req.body.status) ? req.body.status : 'todo';
  const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : 'medium';
  if (!title || title.length > 100) return res.status(400).json({ error: 'Task title must be 1-100 characters.' });
  if (description.length > 1000) return res.status(400).json({ error: 'Description must be 1000 characters or less.' });

  let assigneeId = null;
  if (req.body.assignee) {
    const a = findMemberByName(id, String(req.body.assignee));
    if (!a) return res.status(400).json({ error: 'Assignee must be a project member.' });
    assigneeId = a.id;
  }

  const info = db.prepare(
    'INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, title, description, status, priority, assigneeId, req.user.id);

  if (assigneeId && assigneeId !== req.user.id)
    notifyUser(assigneeId, `${req.user.username} assigned you "${title}"`, id);
  broadcastProject(id);
  res.status(201).json({ id: info.lastInsertRowid });
});

module.exports = router;