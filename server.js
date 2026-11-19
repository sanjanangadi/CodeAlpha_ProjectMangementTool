const express = require('express');
const http = require('http');
const path = require('path');
const { requireAuth } = require('./middleware/auth');
const realtime = require('./realtime');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', requireAuth, require('./routes/projects'));
app.use('/api/tasks', requireAuth, require('./routes/tasks'));
app.use('/api/notifications', requireAuth, require('./routes/notifications'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error.' });
});

// HTTP server is shared by Express and the WebSocket server
const server = http.createServer(app);
realtime.attach(server);
server.listen(PORT, () => console.log(`Boardly running at http://localhost:${PORT}`));