import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

export function signUserToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), email: user.email },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRES_IN }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, config.JWT_SECRET);
}
