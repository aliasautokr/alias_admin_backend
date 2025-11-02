import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole, AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { s3Service } from '../lib/s3'
import { Prisma } from '@prisma/client'

export const inspectionsRouter = Router()

// Validation schemas
const CreateInspectionSchema = z.object({
  title: z.string().min(1).max(255),
  images: z.array(z.string().url()).min(1),
  description: z.any(), // Editor.js JSON
  customerName: z.string().optional(),
})

const UpdateInspectionSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  images: z.array(z.string().url()).optional(),
  description: z.any().optional(),
  customerName: z.string().optional(),
})

const UploadUrlSchema = z.object({
  fileName: z.string().min(1),
  fileType: z.string().min(1),
})

// Middleware to check if user owns the inspection or is SUPER_ADMIN
const requireOwnerOrAdmin = async (req: AuthRequest, res: any, next: any) => {
  const { id } = req.params
  const userId = req.user?.id
  const userRole = req.user?.role

  if (userRole === 'SUPER_ADMIN') {
    return next()
  }

  try {
    const inspection = await prisma.inspection.findUnique({
      where: { id },
      select: { authorId: true }
    })

    if (!inspection) {
      return res.status(404).json({ success: false, error: 'Inspection not found' })
    }

    if (inspection.authorId !== userId) {
      return res.status(403).json({ success: false, error: 'Forbidden' })
    }

    next()
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
}

inspectionsRouter.use(requireAuth)

// DELETE /api/v1/inspections/image - Delete image from S3
inspectionsRouter.delete('/image', async (req: AuthRequest, res) => {
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

// POST /api/v1/inspections/upload-url - Generate presigned URL for image upload
inspectionsRouter.post('/upload-url', async (req: AuthRequest, res) => {
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
    const key = s3Service.generateUniqueKey(fileName, userId, 'Inspection')
    
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

// GET /api/v1/inspections - List all inspections
inspectionsRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 10
    const authorId = req.query.authorId as string
    const skip = (page - 1) * limit

    const where: Prisma.InspectionWhereInput = {}
    if (authorId) {
      where.authorId = authorId
    }

    const [inspections, total] = await Promise.all([
      prisma.inspection.findMany({
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
      prisma.inspection.count({ where })
    ])

    // Generate presigned URLs for all inspections' images
    const inspectionsWithPresignedUrls = await Promise.all(
      inspections.map(async (inspection) => {
        const imagesWithPresignedUrls = await Promise.all(
          inspection.images.map(async (imageUrl) => {
            try {
              const key = imageUrl.split('.com/')[1]
              if (key) {
                const presignedUrl = await s3Service.generatePresignedGetUrl(key)
                return presignedUrl
              }
              return imageUrl
            } catch (error) {
              console.error('Error generating presigned URL for image:', error)
              return imageUrl
            }
          })
        )
        return {
          ...inspection,
          images: imagesWithPresignedUrls,
        }
      })
    )

    return res.json({
      success: true,
      data: {
        items: inspectionsWithPresignedUrls,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      }
    })
  } catch (error) {
    console.error('List inspections error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch inspections' })
  }
})

// GET /api/v1/inspections/:id - Get single inspection
inspectionsRouter.get('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    const inspection = await prisma.inspection.findUnique({
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

    if (!inspection) {
      return res.status(404).json({ success: false, error: 'Inspection not found' })
    }

    // Generate presigned URLs for images
    const imagesWithPresignedUrls = await Promise.all(
      inspection.images.map(async (imageUrl) => {
        try {
          // Extract key from S3 URL
          const key = imageUrl.split('.com/')[1]
          if (key) {
            const presignedUrl = await s3Service.generatePresignedGetUrl(key)
            return presignedUrl
          }
          return imageUrl
        } catch (error) {
          console.error('Error generating presigned URL for image:', error)
          return imageUrl // Fallback to original URL
        }
      })
    )

    return res.json({
      success: true,
      data: {
        ...inspection,
        images: imagesWithPresignedUrls,
      }
    })
  } catch (error) {
    console.error('Get inspection error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch inspection' })
  }
})

// POST /api/v1/inspections - Create inspection
inspectionsRouter.post('/', requireRole('SALES', 'SUPER_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const { title, images, description, customerName } = CreateInspectionSchema.parse(req.body)
    const authorId = req.user!.id

    const inspection = await prisma.inspection.create({
      data: {
        title,
        images,
        description,
        customerName,
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
      data: inspection
    })
  } catch (error) {
    console.error('Create inspection error:', error)
    return res.status(500).json({ success: false, error: 'Failed to create inspection' })
  }
})

// PATCH /api/v1/inspections/:id - Update inspection
inspectionsRouter.patch('/:id', requireOwnerOrAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params
    const updateData = UpdateInspectionSchema.parse(req.body)

    const inspection = await prisma.inspection.update({
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
      data: inspection
    })
  } catch (error) {
    console.error('Update inspection error:', error)
    return res.status(500).json({ success: false, error: 'Failed to update inspection' })
  }
})

// DELETE /api/v1/inspections/:id - Delete inspection
inspectionsRouter.delete('/:id', requireOwnerOrAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    // Get inspection to extract image URLs for S3 cleanup
    const inspection = await prisma.inspection.findUnique({
      where: { id },
      select: { images: true }
    })

    if (!inspection) {
      return res.status(404).json({ success: false, error: 'Inspection not found' })
    }

    // Delete images from S3
    if (inspection.images.length > 0) {
      const keys = inspection.images.map(url => url.split('.com/')[1])
      await s3Service.deleteObjects(keys)
    }

    // Delete inspection from database
    await prisma.inspection.delete({
      where: { id }
    })

    return res.status(204).end()
  } catch (error) {
    console.error('Delete inspection error:', error)
    return res.status(500).json({ success: false, error: 'Failed to delete inspection' })
  }
})
