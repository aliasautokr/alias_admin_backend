import { Router } from 'express'
import { prisma } from '../lib/prisma'

export const publicCollectionsRouter = Router()

// GET /api/v1/public/collections - List all collections
publicCollectionsRouter.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 20
    const skip = (page - 1) * limit

    const [collections, total] = await Promise.all([
      prisma.collection.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          listingId: true,
          data: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.collection.count()
    ])

    return res.json({
      success: true,
      data: {
        items: collections,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        }
      }
    })
  } catch (error) {
    console.error('List public collections error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch collections' })
  }
})

// GET /api/v1/public/collections/:id - Get single collection by ID or listingId
publicCollectionsRouter.get('/:id', async (req, res) => {
  try {
    const { id } = req.params

    // Try to find by ID first (numeric), then by listingId (string)
    const collection = await prisma.collection.findFirst({
      where: {
        OR: [
          { id: isNaN(Number(id)) ? undefined : Number(id) },
          { listingId: id },
        ],
      },
      select: {
        id: true,
        listingId: true,
        data: true,
        createdAt: true,
        updatedAt: true,
      }
    })

    if (!collection) {
      return res.status(404).json({ success: false, error: 'Collection not found' })
    }

    return res.json({
      success: true,
      data: collection
    })
  } catch (error) {
    console.error('Get public collection error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch collection' })
  }
})

