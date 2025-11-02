import { Request, Response, NextFunction } from 'express'
import { verifyAccess } from '../lib/jwt'

export interface AuthRequest extends Request {
  user?: any
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Unauthorized' })
  const token = header.slice(7)
  try {
    const decoded = verifyAccess(token)
    // Map JWT fields to expected user structure
    req.user = {
      id: decoded.sub, // JWT 'sub' field contains the user ID
      role: decoded.role,
      email: decoded.email
    }
    next()
  } catch {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }
}

export function requireRole(...roles: string[]) {
  return function (req: AuthRequest, res: Response, next: NextFunction) {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthorized' })
    if (!roles.includes(req.user.role)) return res.status(403).json({ success: false, error: 'Forbidden' })
    next()
  }
}


