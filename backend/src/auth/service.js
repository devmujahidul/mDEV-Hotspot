import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { ApiError } from '../errors/ApiError.js';
import { signUserToken } from './jwt.js';

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LEN = 8;

export async function register({ email, password, displayName }) {
  if (!email || typeof email !== 'string') throw ApiError.badRequest('email is required');
  if (!password || typeof password !== 'string') throw ApiError.badRequest('password is required');
  if (password.length < MIN_PASSWORD_LEN) {
    throw ApiError.badRequest(`password must be at least ${MIN_PASSWORD_LEN} characters`);
  }

  const normalized = email.toLowerCase().trim();
  const existing = await User.findOne({ email: normalized }).lean();
  if (existing) throw ApiError.conflict('email already registered');

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await User.create({ email: normalized, passwordHash, displayName: displayName || '' });
  const token = signUserToken(user);
  return { user: user.toJSON(), token };
}

export async function login({ email, password }) {
  if (!email || !password) throw ApiError.badRequest('email and password are required');
  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user) throw ApiError.unauthorized('invalid credentials');
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw ApiError.unauthorized('invalid credentials');
  const token = signUserToken(user);
  return { user: user.toJSON(), token };
}
