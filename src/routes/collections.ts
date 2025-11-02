import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole, AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { s3Service } from '../lib/s3'
import { Prisma } from '@prisma/client'

export const collectionsRouter = Router()

// Validation schemas
const CreateCollectionSchema = z.object({
  title: z.string().min(1).max(255),
  images: z.array(z.string().url()).min(1),
  description: z.any(), // Editor.js JSON
})

const UpdateCollectionSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  images: z.array(z.string().url()).optional(),
  description: z.any().optional(),
})

const UploadUrlSchema = z.object({
  fileName: z.string().min(1),
  fileType: z.string().min(1),
})

// Middleware to check if user owns the collection or is SUPER_ADMIN
const requireOwnerOrAdmin = async (req: AuthRequest, res: any, next: any) => {
  const { id } = req.params
  const userId = req.user?.id
  const userRole = req.user?.role

  if (userRole === 'SUPER_ADMIN') {
    return next()
  }

  try {
    const collection = await prisma.collection.findUnique({
      where: { id },
      select: { authorId: true }
    })

    if (!collection) {
      return res.status(404).json({ success: false, error: 'Collection not found' })
    }

    if (collection.authorId !== userId) {
      return res.status(403).json({ success: false, error: 'Forbidden' })
    }

    next()
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
}

collectionsRouter.use(requireAuth)

// DELETE /api/v1/collections/image - Delete image from S3
collectionsRouter.delete('/image', async (req: AuthRequest, res) => {
  try {
    const { imageUrl } = req.body
    
    if (!imageUrl) {
      return res.status(400).json({ 
        success: false, 
        error: 'Image URL is required' 
      })
    }

    // Extract S3 key from URL
    const key = imageUrl.split('.com/')[1]
    if (!key) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid image URL' 
      })
    }

    // Delete from S3
    await s3Service.deleteObject(key)

    return res.json({
      success: true,
      message: 'Image deleted successfully'
    })
  } catch (error) {
    console.error('Delete image error:', error)
    return res.status(500).json({ success: false, error: 'Failed to delete image' })
  }
})

// POST /api/v1/collections/upload-url - Generate presigned URL for image upload
collectionsRouter.post('/upload-url', async (req: AuthRequest, res) => {
  try {
    const { fileName, fileType } = UploadUrlSchema.parse(req.body)

    // Validate file type
    if (!s3Service.isValidImageType(fileType)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid file type. Only images (JPEG, PNG, GIF, WEBP) are allowed.' 
      })
    }

    const userId = req.user!.id
    console.log('Upload URL request - User ID:', userId, 'User:', req.user)
    const key = s3Service.generateUniqueKey(fileName, userId)
    
    const { uploadUrl, imageUrl, key: s3Key } = await s3Service.generatePresignedUploadUrl(
      key,
      fileType,
      900 // 15 minutes
    )

    return res.json({
      success: true,
      data: {
        uploadUrl,
        imageUrl,
        key: s3Key,
      }
    })
  } catch (error) {
    console.error('Upload URL generation error:', error)
    return res.status(500).json({ success: false, error: 'Failed to generate upload URL' })
  }
})

// GET /api/v1/collections - List all collections
collectionsRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 10
    const authorId = req.query.authorId as string
    const skip = (page - 1) * limit

    const where: Prisma.CollectionWhereInput = {}
    if (authorId) {
      where.authorId = authorId
    }

    const [collections, total] = await Promise.all([
      prisma.collection.findMany({
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
      prisma.collection.count({ where })
    ])

    // Return collections with their public S3 URLs

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
    console.error('List collections error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch collections' })
  }
})

// GET /api/v1/collections/:id - Get single collection
collectionsRouter.get('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    const collection = await prisma.collection.findUnique({
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

    if (!collection) {
      return res.status(404).json({ success: false, error: 'Collection not found' })
    }

    return res.json({
      success: true,
      data: collection
    })
  } catch (error) {
    console.error('Get collection error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch collection' })
  }
})

// POST /api/v1/collections - Create collection
collectionsRouter.post('/', requireRole('SALES', 'SUPER_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const { title, images, description } = CreateCollectionSchema.parse(req.body)
    const authorId = req.user!.id

    const collection = await prisma.collection.create({
      data: {
        title,
        images,
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
      data: collection
    })
  } catch (error) {
    console.error('Create collection error:', error)
    return res.status(500).json({ success: false, error: 'Failed to create collection' })
  }
})

// PATCH /api/v1/collections/:id - Update collection
collectionsRouter.patch('/:id', requireOwnerOrAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params
    const updateData = UpdateCollectionSchema.parse(req.body)

    const collection = await prisma.collection.update({
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
      data: collection
    })
  } catch (error) {
    console.error('Update collection error:', error)
    return res.status(500).json({ success: false, error: 'Failed to update collection' })
  }
})

// DELETE /api/v1/collections/:id - Delete collection
collectionsRouter.delete('/:id', requireOwnerOrAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    // Get collection to extract image URLs for S3 cleanup
    const collection = await prisma.collection.findUnique({
      where: { id },
      select: { images: true }
    })

    if (!collection) {
      return res.status(404).json({ success: false, error: 'Collection not found' })
    }

    // Delete images from S3
    if (collection.images.length > 0) {
      const keys = collection.images.map(url => s3Service.extractKeyFromUrl(url))
      await s3Service.deleteObjects(keys)
    }

    // Delete collection from database
    await prisma.collection.delete({
      where: { id }
    })

    return res.status(204).end()
  } catch (error) {
    console.error('Delete collection error:', error)
    return res.status(500).json({ success: false, error: 'Failed to delete collection' })
  }
})
