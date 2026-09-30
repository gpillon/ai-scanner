const jwt = require('jsonwebtoken');
const config = require('./config');

const ALGORITHM = 'HS256';

function issueToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { algorithm: ALGORITHM, expiresIn: '1h' });
}

function requireUser(req, res, next) {
  const header = req.headers.authorization || '';
  try {
    req.user = jwt.verify(header.replace(/^Bearer /, ''), config.jwtSecret, { algorithms: [ALGORITHM] });
    next();
  } catch {
    res.status(401).end();
  }
}

module.exports = { issueToken, requireUser };
