import { Router } from 'express'
import { z } from 'zod'
import { verifyGoogleIdToken } from '../lib/google'
import { Prisma, Role } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { signAccess, signRefresh, verifyRefresh } from '../lib/jwt'
import crypto from 'crypto'

export const authRouter = Router()

const GoogleBody = z.object({ idToken: z.string().min(10) })

authRouter.post('/google', async (req, res) => {
  const parsed = GoogleBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid body' })
  const { idToken } = parsed.data

  const payload = await verifyGoogleIdToken(idToken)
  const email = payload.email!
  const googleId = payload.sub!
  const name = payload.name ?? null
  const image = payload.picture ?? null

  const count = await prisma.user.count()
  const role = count === 0 ? Role.SUPER_ADMIN : Role.USER

  const user = await prisma.user.upsert({
    where: { email },
    create: { email, googleId, name, image, role },
    update: { googleId, name, image },
  })

  const accessToken = signAccess({ sub: user.id, role: user.role, email: user.email })
  const rawRefresh = crypto.randomBytes(32).toString('hex')
  const hashed = crypto.createHash('sha256').update(rawRefresh).digest('hex')
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000)
  await prisma.refreshToken.create({ data: { userId: user.id, hashedToken: hashed, expiresAt } })

  return res.json({ success: true, data: { user, accessToken, refreshToken: rawRefresh, expiresIn: 900 } })
})

authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {}
  if (!refreshToken) return res.status(400).json({ success: false, error: 'Missing refreshToken' })
  const hashed = crypto.createHash('sha256').update(refreshToken).digest('hex')
  const token = await prisma.refreshToken.findFirst({ where: { hashedToken: hashed, revokedAt: null } })
  if (!token || token.expiresAt < new Date()) return res.status(401).json({ success: false, error: 'Invalid refresh' })
  const user = await prisma.user.findUnique({ where: { id: token.userId } })
  if (!user) return res.status(401).json({ success: false, error: 'Invalid refresh' })

  // rotate
  const rawRefresh = crypto.randomBytes(32).toString('hex')
  const newHashed = crypto.createHash('sha256').update(rawRefresh).digest('hex')
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000)
  await prisma.$transaction([
    prisma.refreshToken.update({ where: { id: token.id }, data: { revokedAt: new Date(), replacedByToken: newHashed } }),
    prisma.refreshToken.create({ data: { userId: user.id, hashedToken: newHashed, expiresAt } }),
  ])

  const accessToken = signAccess({ sub: user.id, role: user.role, email: user.email })
  return res.json({ success: true, data: { accessToken, refreshToken: rawRefresh, expiresIn: 900 } })
})

authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = req.body || {}
  if (!refreshToken) return res.status(200).json({ success: true })
  const hashed = crypto.createHash('sha256').update(refreshToken).digest('hex')
  await prisma.refreshToken.updateMany({ where: { hashedToken: hashed, revokedAt: null }, data: { revokedAt: new Date() } })
  return res.json({ success: true })
})

authRouter.get('/me', async (req, res) => {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Unauthorized' })
  // This should verify access token, not refresh
  const [, token] = auth.split(' ')
  try {
    const payload: any = (await import('../lib/jwt')).verifyAccess(token)
    const user = await prisma.user.findUnique({ where: { id: payload.sub } })
    if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' })
    return res.json({ success: true, data: user })
  } catch {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }
})

authRouter.get('/setup-status', async (_req, res) => {
  return res.json({ success: true, data: { status: 'ready' } })
})


