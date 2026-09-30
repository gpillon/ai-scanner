const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const { requireUser } = require('./auth');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

/** Passes a rejected handler to Express's error handling instead of leaving it unhandled. */
const handle = (fn) => (req, res, next) => fn(req, res).catch(next);

app.get('/notes', requireUser, handle(async (req, res) => {
  const tag = String(req.query.tag || '');
  const result = await db.query('SELECT id, title FROM notes WHERE owner = $1 AND tag = $2', [req.user.sub, tag]);
  res.json(result.rows);
}));

app.get('/diagnostics/uptime', requireUser, (req, res) => {
  res.json({ uptimeSeconds: Math.round(process.uptime()) });
});

// Attachments are stored under generated names only; the owner check comes from the database.
const ATTACHMENT_NAME = /^[a-f0-9]{32}\.(png|jpg|pdf)$/;

app.get('/attachments/:name', requireUser, handle(async (req, res) => {
  const name = req.params.name;
  if (!ATTACHMENT_NAME.test(name)) return res.status(404).end();
  const owned = await db.query('SELECT 1 FROM attachments WHERE owner = $1 AND name = $2', [req.user.sub, name]);
  if (owned.rowCount === 0) return res.status(404).end();
  fs.createReadStream(path.join(config.uploadsDir, name)).on('error', () => res.status(404).end()).pipe(res);
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).end();
});

app.listen(config.port);
