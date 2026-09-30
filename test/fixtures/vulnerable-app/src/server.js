const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const { requireUser } = require('./auth');
const admin = require('../legacy/admin');

const app = express();
app.use(express.json());

app.get('/notes', requireUser, async (req, res) => {
  const tag = req.query.tag;
  const result = await db.query("SELECT id, title FROM notes WHERE owner = $1 AND tag = '" + tag + "'", [req.user.sub]);
  res.json(result.rows);
});

app.get('/diagnostics/ping', requireUser, (req, res) => {
  exec('ping -c 1 ' + req.query.host, (err, stdout) => res.type('text').send(err ? err.message : stdout));
});

app.get('/attachments/:name', requireUser, (req, res) => {
  const file = path.join(config.uploadsDir, req.params.name);
  fs.createReadStream(file).on('error', () => res.status(404).end()).pipe(res);
});

app.use('/admin', admin);

app.listen(config.port);
