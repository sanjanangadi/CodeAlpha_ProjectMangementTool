// WebSocket layer: live board updates + instant notifications
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { db, memberIds } = require('./db');
const { JWT_SECRET } = require('./middleware/auth');

const clients = new Map(); // userId -> Set of open sockets

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    let userId;
    try {
      const token = new URL(req.url, 'http://localhost').searchParams.get('token');
      userId = jwt.verify(token, JWT_SECRET).id;
    } catch {
      ws.close(1008, 'Unauthorized');
      return;
    }

    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId).add(ws);

    ws.on('close', () => {
      const set = clients.get(userId);
      if (!set) return;
      set.delete(ws);
      if (!set.size) clients.delete(userId);
    });
  });
}

function sendTo(userIds, payload) {
  const message = JSON.stringify(payload);
  for (const id of userIds) {
    for (const ws of clients.get(id) || []) {
      if (ws.readyState === 1) ws.send(message);
    }
  }
}

// Tell every member of a project that something changed (their board refreshes)
function broadcastProject(projectId) {
  sendTo(memberIds(projectId), { type: 'project', projectId });
}

// Save a notification and push it live to the user
function notifyUser(userId, message, projectId) {
  db.prepare('INSERT INTO notifications (user_id, message, project_id) VALUES (?, ?, ?)').run(userId, message, projectId ?? null);
  sendTo([userId], { type: 'notification', message, projectId });
}

module.exports = { attach, sendTo, broadcastProject, notifyUser };