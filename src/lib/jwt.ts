import jwt, { Secret } from 'jsonwebtoken'
import { env } from '../config/env'

const ACCESS_SECRET: Secret = env.JWT_ACCESS_SECRET

export function signAccess(payload: object, expiresIn: string | number = '2h') {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn } as any)
}

export function verifyAccess(token: string) {
  return jwt.verify(token, ACCESS_SECRET) as any
}
