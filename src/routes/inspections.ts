import { Router } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { requireAuth, requireRole, AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { s3Service } from '../lib/s3'
import { optimizeImage } from '../lib/image-optimizer'
import { Prisma, Role } from '@prisma/client'

export const inspectionsRouter = Router()

// Configure multer for memory storage (no disk writes)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max file size before optimization
  },
  fileFilter: (req, file, cb) => {
    if (s3Service.isValidImageType(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Invalid file type. Only images (JPEG, PNG, GIF, WEBP) are allowed.'))
    }
  },
})

// Helper function to generate inspectionId (8-digit number)
const generateInspectionId = () => Math.floor(10000000 + Math.random() * 90000000).toString()

// Validation schemas
const CreateInspectionSchema = z.object({
  title: z.string().min(1).max(255),
  images: z.array(z.string().url()).min(1),
  description: z.any(), // Editor.js JSON
  customerName: z.string().optional(),
  inspectorName: z.string().optional(),
  inspectionId: z.string().optional(),
  link: z.string().optional(),
})

const UpdateInspectionSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  images: z.array(z.string().url()).optional(),
  description: z.any().optional(),
  customerName: z.string().optional(),
  inspectorName: z.string().optional(),
  inspectionId: z.string().optional(),
  link: z.string().optional(),
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

  if (userRole === Role.SUPER_ADMIN) {
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

// POST /api/v1/inspections/upload-image - Upload and optimize image
inspectionsRouter.post('/upload-image', requireAuth, upload.single('image'), async (req: AuthRequest, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No image file provided' 
      })
    }

    const userId = req.user!.id
    const originalFileName = req.file.originalname
    const originalSize = req.file.size

    console.log(`Uploading inspection image: ${originalFileName} (${(originalSize / 1024 / 1024).toFixed(2)}MB) - User ID: ${userId}`)

    // Optimize the image
    const optimized = await optimizeImage(req.file.buffer, {
      maxWidth: 1920,
      maxHeight: 1920,
      quality: 85,
    })

    const compressionRatio = ((1 - optimized.optimizedSize / originalSize) * 100).toFixed(1)
    console.log(`Image optimized: ${originalFileName} - ${(originalSize / 1024 / 1024).toFixed(2)}MB → ${(optimized.optimizedSize / 1024 / 1024).toFixed(2)}MB (${compressionRatio}% reduction)`)

    // Generate S3 key with optimized extension
    const extension = optimized.contentType.split('/')[1] // 'jpeg', 'png', or 'webp'
    const baseFileName = originalFileName.split('.')[0]
    const key = s3Service.generateUniqueKey(`${baseFileName}.${extension}`, userId, 'Inspection')

    // Upload optimized image to S3
    const imageUrl = await s3Service.uploadFile(key, optimized.buffer, optimized.contentType)

    return res.json({
      success: true,
      data: {
        imageUrl,
        key,
        originalSize,
        optimizedSize: optimized.optimizedSize,
        compressionRatio: `${compressionRatio}%`,
        width: optimized.width,
        height: optimized.height,
        contentType: optimized.contentType,
      }
    })
  } catch (error: any) {
    console.error('Image upload error:', error)
    
    // Handle multer errors
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ 
          success: false, 
          error: 'File size too large. Maximum size is 10MB.' 
        })
      }
    }
    
    return res.status(500).json({ 
      success: false, 
      error: error?.message || 'Failed to upload and optimize image' 
    })
  }
})

// POST /api/v1/inspections/upload-url - Generate presigned URL for image upload (legacy, kept for backward compatibility)
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
inspectionsRouter.get('/', requireRole(Role.SUPER_ADMIN, Role.SALES), async (req: AuthRequest, res) => {
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
          User: {
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
inspectionsRouter.get('/:id', requireRole(Role.SUPER_ADMIN, Role.SALES), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    const inspection = await prisma.inspection.findUnique({
      where: { id },
      include: {
        User: {
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
inspectionsRouter.post('/', requireRole(Role.SALES, Role.SUPER_ADMIN), async (req: AuthRequest, res) => {
  try {
    const { title, images, description, customerName, inspectorName, inspectionId: providedInspectionId, link: providedLink } = CreateInspectionSchema.parse(req.body)
    const authorId = req.user!.id

    // Generate inspectionId if not provided or if empty string
    let inspectionId: string
    if (providedInspectionId && providedInspectionId.trim()) {
      // Use provided inspectionId
      inspectionId = providedInspectionId.trim()
      
      // Check if it already exists
      const existing = await prisma.inspection.findUnique({
        where: { inspectionId },
        select: { id: true }
      })
      
      if (existing) {
        return res.status(400).json({ 
          success: false, 
          error: `Inspection ID "${inspectionId}" already exists. Please use a different ID.` 
        })
      }
    } else {
      // Generate a unique inspectionId
      let attempts = 0
      const maxAttempts = 10
      do {
        inspectionId = generateInspectionId()
        // Check if it already exists
        const existing = await prisma.inspection.findUnique({
          where: { inspectionId },
          select: { id: true }
        })
        if (!existing) break
        attempts++
      } while (attempts < maxAttempts)
      
      if (attempts >= maxAttempts) {
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to generate unique inspection ID. Please try again.' 
        })
      }
    }
    
    // Generate link if not provided
    const link = providedLink?.trim() || `aliasauto.kr/inspection/${inspectionId}`

    const inspection = await prisma.inspection.create({
      data: {
        id: crypto.randomUUID(),
        title,
        images,
        description,
        customerName,
        inspectorName,
        inspectionId,
        link,
        authorId,
      },
      include: {
        User: {
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
  } catch (error: any) {
    console.error('Create inspection error:', error)
    
    // Handle Prisma unique constraint errors
    if (error?.code === 'P2002') {
      return res.status(400).json({ 
        success: false, 
        error: `Inspection ID "${providedInspectionId || inspectionId}" already exists. Please try again.` 
      })
    }
    
    // Handle validation errors
    if (error instanceof z.ZodError) {
      return res.status(400).json({ 
        success: false, 
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ') 
      })
    }
    
    // Return more detailed error message
    const errorMessage = error?.message || 'Failed to create inspection'
    return res.status(500).json({ 
      success: false, 
      error: errorMessage 
    })
  }
})

// PATCH /api/v1/inspections/:id - Update inspection
inspectionsRouter.patch('/:id', requireOwnerOrAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params
    const { inspectionId: providedInspectionId, link: providedLink, ...restData } = UpdateInspectionSchema.parse(req.body)

    // Prepare update data
    const updateData: any = { ...restData }

    // If inspectionId is provided, update it and regenerate link
    if (providedInspectionId) {
      updateData.inspectionId = providedInspectionId
      updateData.link = providedLink || `aliasauto.kr/inspection/${providedInspectionId}`
    } else if (providedLink) {
      // If only link is provided, update it
      updateData.link = providedLink
    }

    const inspection = await prisma.inspection.update({
      where: { id },
      data: updateData,
      include: {
        User: {
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
