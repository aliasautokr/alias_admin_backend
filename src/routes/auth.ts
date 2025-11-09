import { Router } from 'express'
import { z } from 'zod'
import { verifyGoogleIdToken } from '../lib/google'
import { Role } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { signAccess, verifyAccess } from '../lib/jwt'
import crypto from 'crypto'

export const authRouter = Router()

const GoogleBody = z.object({ idToken: z.string().min(10) })
const RefreshBody = z.object({ refreshToken: z.string().min(10) })

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const ACCESS_EXPIRES_IN_SECONDS = 2 * 60 * 60

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

  await prisma.refreshToken.deleteMany({ where: { userId: user.id } })

  const rawRefreshToken = crypto.randomBytes(32).toString('hex')
  const hashedRefreshToken = crypto.createHash('sha256').update(rawRefreshToken).digest('hex')

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      hashedToken: hashedRefreshToken,
      expiresAt: new Date(Date.now() + THIRTY_DAYS_MS),
    },
  })

  const accessToken = signAccess({ sub: user.id, role: user.role, email: user.email })

  return res.json({
    success: true,
    data: {
      user,
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn: ACCESS_EXPIRES_IN_SECONDS,
    },
  })
})

authRouter.post('/refresh', async (req, res) => {
  const parsed = RefreshBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid body' })

  const { refreshToken } = parsed.data
  const hashedToken = crypto.createHash('sha256').update(refreshToken).digest('hex')

  const storedToken = await prisma.refreshToken.findFirst({
    where: { hashedToken, revokedAt: null },
  })

  if (!storedToken || storedToken.expiresAt <= new Date()) {
    return res.status(401).json({ success: false, error: 'Invalid refresh token' })
  }

  const user = await prisma.user.findUnique({ where: { id: storedToken.userId } })
  if (!user) return res.status(401).json({ success: false, error: 'Invalid refresh token' })

  const accessToken = signAccess({ sub: user.id, role: user.role, email: user.email })

  return res.json({
    success: true,
    data: {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_EXPIRES_IN_SECONDS,
    },
  })
})

authRouter.post('/logout', async (req, res) => {
  const parsed = RefreshBody.safeParse(req.body ?? {})
  if (!parsed.success) return res.json({ success: true })

  const { refreshToken } = parsed.data
  const hashedToken = crypto.createHash('sha256').update(refreshToken).digest('hex')

  await prisma.refreshToken.updateMany({
    where: { hashedToken, revokedAt: null },
    data: { revokedAt: new Date() },
  })

  return res.json({ success: true })
})

authRouter.get('/me', async (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }

  const token = authHeader.split(' ')[1]

  try {
    const payload: any = verifyAccess(token)
    const user = await prisma.user.findUnique({ where: { id: payload.sub } })
    if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' })

    return res.json({ success: true, data: user })
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }
})
