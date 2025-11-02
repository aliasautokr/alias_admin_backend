import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole, AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { Prisma } from '@prisma/client'

export const portInfosRouter = Router()

// Validation schemas
const CreatePortInfoSchema = z.object({
  shortAddress: z.string().min(1).max(255),
  description: z.string().min(1),
})

const UpdatePortInfoSchema = z.object({
  shortAddress: z.string().min(1).max(255).optional(),
  description: z.string().min(1).optional(),
})

// Middleware to check if user owns the port info or is SUPER_ADMIN
const requireOwnerOrAdmin = async (req: AuthRequest, res: any, next: any) => {
  const { id } = req.params
  const userId = req.user?.id
  const userRole = req.user?.role

  if (userRole === 'SUPER_ADMIN') {
    return next()
  }

  try {
    const portInfo = await prisma.portInfo.findUnique({
      where: { id },
      select: { authorId: true }
    })

    if (!portInfo) {
      return res.status(404).json({ success: false, error: 'Port info not found' })
    }

    if (portInfo.authorId !== userId) {
      return res.status(403).json({ success: false, error: 'Forbidden' })
    }

    next()
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
}

portInfosRouter.use(requireAuth)

// GET /api/v1/port-infos - List all port infos
portInfosRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 10
    const authorId = req.query.authorId as string
    const skip = (page - 1) * limit

    const where: Prisma.PortInfoWhereInput = {}
    if (authorId) {
      where.authorId = authorId
    }

    const [portInfos, total] = await Promise.all([
      prisma.portInfo.findMany({
        where,
        include: {
          author: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.portInfo.count({ where })
    ])

    return res.json({
      success: true,
      data: {
        items: portInfos,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        }
      }
    })
  } catch (error) {
    console.error('List port infos error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch port infos' })
  }
})

// GET /api/v1/port-infos/:id - Get single port info
portInfosRouter.get('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    const portInfo = await prisma.portInfo.findUnique({
      where: { id },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          }
        }
      }
    })

    if (!portInfo) {
      return res.status(404).json({ success: false, error: 'Port info not found' })
    }

    return res.json({
      success: true,
      data: portInfo
    })
  } catch (error) {
    console.error('Get port info error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch port info' })
  }
})

// POST /api/v1/port-infos - Create port info
portInfosRouter.post('/', requireRole('SALES', 'SUPER_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const { shortAddress, description } = CreatePortInfoSchema.parse(req.body)
    const authorId = req.user!.id

    const portInfo = await prisma.portInfo.create({
      data: {
        shortAddress,
        description,
        authorId,
      },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          }
        }
      }
    })

    return res.status(201).json({
      success: true,
      data: portInfo
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.errors })
    }
    console.error('Create port info error:', error)
    return res.status(500).json({ success: false, error: 'Failed to create port info' })
  }
})

// PATCH /api/v1/port-infos/:id - Update port info
portInfosRouter.patch('/:id', requireOwnerOrAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params
    const updateData = UpdatePortInfoSchema.parse(req.body)

    const portInfo = await prisma.portInfo.update({
      where: { id },
      data: updateData,
      include: {
        author: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          }
        }
      }
    })

    return res.json({
      success: true,
      data: portInfo
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.errors })
    }
    console.error('Update port info error:', error)
    return res.status(500).json({ success: false, error: 'Failed to update port info' })
  }
})

// DELETE /api/v1/port-infos/:id - Delete port info
portInfosRouter.delete('/:id', requireOwnerOrAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    await prisma.portInfo.delete({
      where: { id }
    })

    return res.status(204).end()
  } catch (error) {
    console.error('Delete port info error:', error)
    return res.status(500).json({ success: false, error: 'Failed to delete port info' })
  }
})

