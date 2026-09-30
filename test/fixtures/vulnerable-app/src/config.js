module.exports = {
  port: Number(process.env.PORT || 8080),
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET || 'notes-dev-secret',
  uploadsDir: process.env.UPLOADS_DIR || '/var/lib/notes/uploads',
};
