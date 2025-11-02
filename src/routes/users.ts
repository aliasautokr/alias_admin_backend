import { Router } from 'express'
import { requireAuth, requireRole, AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { Role } from '@prisma/client'

export const usersRouter = Router()

const VALID_ROLES = Object.values(Role)

usersRouter.use(requireAuth)

usersRouter.get('/', requireRole(Role.SUPER_ADMIN), async (_req, res) => {
  const list = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } })
  return res.json({ success: true, data: list, pagination: { page: 1, pageSize: list.length, total: list.length, totalPages: 1 } })
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


