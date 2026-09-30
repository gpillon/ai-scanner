function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

module.exports = {
  port: Number(process.env.PORT || 8080),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  uploadsDir: process.env.UPLOADS_DIR || '/var/lib/notes/uploads',
};
