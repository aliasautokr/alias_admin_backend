import { Router } from 'express'
import { requireAuth, requireRole, AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { Role } from '@prisma/client'

export const usersRouter = Router()

const VALID_ROLES = Object.values(Role)

usersRouter.use(requireAuth)

usersRouter.get('/', requireRole(Role.SUPER_ADMIN), async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 20
    const skip = (page - 1) * limit

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.user.count()
    ])

    return res.json({
      success: true,
      data: {
        items: users,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        }
      }
    })
  } catch (error) {
    console.error('List users error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch users' })
  }
})

usersRouter.patch('/:id/role', requireRole(Role.SUPER_ADMIN), async (req: AuthRequest, res) => {
  const { id } = req.params
  const { role } = req.body || {}
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ success: false, error: 'Invalid role' })
  const updated = await prisma.user.update({ where: { id }, data: { role } })
  return res.json({ success: true, data: updated })
})

usersRouter.delete('/:id', requireRole(Role.SUPER_ADMIN), async (req, res) => {
  const { id } = req.params
  await prisma.user.delete({ where: { id } })
  return res.status(204).end()
})


