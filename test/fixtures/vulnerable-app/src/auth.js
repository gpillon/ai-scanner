const jwt = require('jsonwebtoken');
const config = require('./config');

function issueToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: '1h' });
}

function requireUser(req, res, next) {
  const header = req.headers.authorization || '';
  try {
    req.user = jwt.verify(header.replace(/^Bearer /, ''), config.jwtSecret);
    next();
  } catch {
    res.status(401).end();
  }
}

module.exports = { issueToken, requireUser };
