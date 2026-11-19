# Boardly

A pastel, Trello-style project board for small teams. Create projects, add teammates, assign tasks, comment on cards, and watch the board update live.

## Features

- Sign up and log in
- Group projects with an owner and members
- Three-column board: To Do, In Progress, Done (drag and drop)
- Task priority, assignee, description and comments
- Notifications for assignments, moves and comments
- Live updates over WebSockets

## Tech

- Node.js, Express
- SQLite (better-sqlite3)
- bcryptjs and JSON Web Tokens for login
- ws for live updates
- Vanilla JavaScript front end (no framework)

## Run it

```bash
npm install
npm start
```

Then open http://localhost:3000

The database file `boardly.db` is created automatically the first time you start the server.

## Folder layout

```
Boardly
├── middleware/auth.js
├── public/ (index.html, style.css, app.js)
├── routes/ (auth.js, projects.js, tasks.js, notifications.js)
├── db.js
├── realtime.js
├── server.js
├── package.json
└── README.md
```

## Notes

- `boardly.db`, `node_modules` and `package-lock.json` are generated automatically. Do not create them by hand.
- Add `node_modules` and `boardly.db` to `.gitignore`.
# Author 
 -Sanjana M angadi 
 