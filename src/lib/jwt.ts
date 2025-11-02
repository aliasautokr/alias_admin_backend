import jwt, { Secret, SignOptions } from 'jsonwebtoken'
import { env } from '../config/env'

const ACCESS_SECRET: Secret = env.JWT_ACCESS_SECRET
const REFRESH_SECRET: Secret = env.JWT_REFRESH_SECRET

export function signAccess(payload: object, expiresIn: string | number = '15m') {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn } as any)
}

export function signRefresh(payload: object, expiresIn: string | number = '30d') {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn } as any)
}

export function verifyAccess(token: string) {
  return jwt.verify(token, ACCESS_SECRET) as any
}

export function verifyRefresh(token: string) {
  return jwt.verify(token, REFRESH_SECRET) as any
}


