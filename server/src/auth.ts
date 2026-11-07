import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import { config } from './config.js';

const COOKIE = 'operator_session';
const MAX_AGE = 60 * 60 * 12;
function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function signature(value: string): string {
  return createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}
export function hasSession(cookieHeader: string | undefined): boolean {
  if (!config.sessionSecret) return false;
  const token = parseCookie(cookieHeader || '')[COOKIE];
  if (!token) return false;
  const [expires, nonce, mac] = token.split('.');
  if (!expires || !nonce || !mac || Number(expires) < Date.now()) return false;
  return safeEqual(mac, signature(`${expires}.${nonce}`));
}
export function setSession(res: Response): void {
  const expires = String(Date.now() + MAX_AGE * 1000);
  const nonce = randomBytes(16).toString('base64url');
  const value = `${expires}.${nonce}.${signature(`${expires}.${nonce}`)}`;
  res.setHeader('Set-Cookie', serializeCookie(COOKIE, value, {
    httpOnly: true, secure: config.production, sameSite: 'lax', path: '/', maxAge: MAX_AGE,
  }));
}
export function clearSession(res: Response): void {
  res.setHeader('Set-Cookie', serializeCookie(COOKIE, '', {
    httpOnly: true, secure: config.production, sameSite: 'lax', path: '/', maxAge: 0,
  }));
}
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!hasSession(req.headers.cookie)) { res.status(401).json({ error: 'Sessão expirada. Entre novamente.' }); return; }
  next();
}
export function passwordMatches(input: string): boolean {
  return Boolean(config.operatorPassword && safeEqual(input, config.operatorPassword));
}
