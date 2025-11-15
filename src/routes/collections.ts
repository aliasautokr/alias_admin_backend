import { Router } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { requireAuth, requireRole, AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { s3Service } from '../lib/s3'
import { optimizeImage } from '../lib/image-optimizer'
import { Prisma, Role } from '@prisma/client'

export const collectionsRouter = Router()

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

// Validation schemas
const fuelTypeEnum = ['gasoline', 'diesel', 'hybrid', 'electric'] as const
const transmissionEnum = ['automatic', 'manual', 'cvt', 'dct'] as const

const fuelTypeMap: Record<string, (typeof fuelTypeEnum)[number]> = {
  gasoline: 'gasoline',
  petrol: 'gasoline',
  бензин: 'gasoline',
  дизель: 'diesel',
  diesel: 'diesel',
  disil: 'diesel',
  hybrid: 'hybrid',
  гибрид: 'hybrid',
  electric: 'electric',
  электро: 'electric',
  electrical: 'electric',
  ev: 'electric',
}

const transmissionMap: Record<string, (typeof transmissionEnum)[number]> = {
  automatic: 'automatic',
  авто: 'automatic',
  auto: 'automatic',
  manual: 'manual',
  mechanic: 'manual',
  mechanical: 'manual',
  механика: 'manual',
  cvt: 'cvt',
  variator: 'cvt',
  вариатор: 'cvt',
  dct: 'dct',
  robot: 'dct',
  robotic: 'dct',
  робот: 'dct',
}

const normalizeEnumValue = <T extends string>(map: Record<string, T>, value: unknown): unknown => {
  if (typeof value !== 'string') return value
  const normalized = value.trim().toLowerCase()
  return map[normalized] ?? value
}

const FuelTypeSchema = z.preprocess(
  (value) => normalizeEnumValue(fuelTypeMap, value),
  z.enum(fuelTypeEnum)
)

const TransmissionSchema = z.preprocess(
  (value) => normalizeEnumValue(transmissionMap, value),
  z.enum(transmissionEnum)
)

const strictLocalizedStringSchema = z.object({
  ru: z.string().min(1),
  en: z.string().optional(),
  uz: z.string().optional(),
  kz: z.string().optional(),
  ko: z.string().optional(),
})

const LocalizedStringSchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    return {
      ru: value,
      en: value,
      uz: value,
      kz: value,
      ko: value,
    }
  }

  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const ruCandidate =
      typeof source.ru === 'string' && source.ru.trim()
        ? (source.ru as string).trim()
        : [source.en, source.uz, source.kz, source.ko].find(
            (candidate) => typeof candidate === 'string' && candidate.trim()
          ) ?? ''

    return {
      ru: ruCandidate,
      en: typeof source.en === 'string' && source.en.trim() ? (source.en as string).trim() : ruCandidate,
      uz: typeof source.uz === 'string' && source.uz.trim() ? (source.uz as string).trim() : ruCandidate,
      kz: typeof source.kz === 'string' && source.kz.trim() ? (source.kz as string).trim() : ruCandidate,
      ko: typeof source.ko === 'string' && source.ko.trim() ? (source.ko as string).trim() : ruCandidate,
    }
  }

  return value
}, strictLocalizedStringSchema)

const AdditionalOptionSchema = LocalizedStringSchema

const InspectionHistorySchema = z
  .object({
    accidents: z.boolean().optional(),
    maintenanceHistory: LocalizedStringSchema.optional(),
  })
  .optional()

const SpecsSchema = z.object({
  year: z.number().int().nonnegative().optional(),
  mileageKm: z.number().int().nonnegative().optional(),
  fuelType: FuelTypeSchema.optional(),
  transmission: TransmissionSchema.optional(),
  engineDisplacementCc: z.number().int().nonnegative().optional(),
  priceKRW: z.number().nonnegative().optional(),
  currency: z.string().optional(),
})

const TextSchema = z.object({
  make: LocalizedStringSchema,
  model: LocalizedStringSchema,
  trim: LocalizedStringSchema.optional(),
  bodyType: LocalizedStringSchema.optional(),
  color: LocalizedStringSchema.optional(),
  interiorColor: LocalizedStringSchema.optional(),
  description: LocalizedStringSchema.optional(),
})

const CollectionDataSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object') {
    return value
  }

  const data = value as Record<string, any>

  if ('specs' in data && 'text' in data) {
    return value
  }

  const specs = {
    year: data.year,
    mileageKm: data.mileageKm,
    fuelType: data.fuelType,
    transmission: data.transmission,
    engineDisplacementCc: data.engineDisplacementCc,
    priceKRW: data.priceKRW,
    currency: data.currency,
  }

  const text = {
    make: data.make,
    model: data.model,
    trim: data.trim,
    bodyType: data.bodyType,
    color: data.color,
    interiorColor: data.interiorColor,
    description: data.description,
  }

  return {
    specs,
    text,
    additionalOptions: data.additionalOptions,
    inspectionHistory: data.inspectionHistory,
    images: data.images ?? [],
  }
}, z.object({
  specs: SpecsSchema,
  text: TextSchema,
  additionalOptions: z.array(AdditionalOptionSchema).optional(),
  inspectionHistory: InspectionHistorySchema,
  images: z.array(z.string().url()).min(1),
}))

const CreateCollectionSchema = z.object({
  listingId: z.string().min(1),
  data: CollectionDataSchema,
})

const UpdateCollectionSchema = z.object({
  listingId: z.string().min(1).optional(),
  data: CollectionDataSchema.optional(),
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

  if (userRole === Role.SUPER_ADMIN) {
    return next()
  }

  try {
    // Parse ID - could be integer ID or string listingId
    const numericId = parseInt(id, 10)
    const where = !isNaN(numericId) ? { id: numericId } : { listingId: id }

    const collection = await prisma.collection.findUnique({
      where,
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
    console.error('requireOwnerOrAdmin error:', error)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
}

// Protected routes (authentication required)
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

// POST /api/v1/collections/upload-image - Upload and optimize image
collectionsRouter.post('/upload-image', requireAuth, upload.single('image'), async (req: AuthRequest, res) => {
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

    console.log(`Uploading image: ${originalFileName} (${(originalSize / 1024 / 1024).toFixed(2)}MB) - User ID: ${userId}`)

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
    const key = s3Service.generateUniqueKey(`${baseFileName}.${extension}`, userId)

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

// POST /api/v1/collections/upload-url - Generate presigned URL for image upload (legacy, kept for backward compatibility)
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
collectionsRouter.get('/', requireRole(Role.SUPER_ADMIN, Role.SALES, Role.MARKETING), async (req: AuthRequest, res) => {
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
collectionsRouter.get('/:id', requireRole(Role.SUPER_ADMIN, Role.SALES, Role.MARKETING), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    // Parse ID - could be integer ID or string listingId
    const numericId = parseInt(id, 10)
    let collection

    // Try to find by ID first (numeric)
    if (!isNaN(numericId)) {
      collection = await prisma.collection.findUnique({
        where: { id: numericId },
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
    }

    // If not found by ID, try finding by listingId (string)
    if (!collection) {
      collection = await prisma.collection.findUnique({
        where: { listingId: id },
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
    }

    if (!collection) {
      return res.status(404).json({ success: false, error: 'Collection not found' })
    }

    return res.json({
      success: true,
      data: collection
    })
  } catch (error) {
    console.error('Get collection error:', error)
    return res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to fetch collection' 
    })
  }
})

// POST /api/v1/collections - Create collection
collectionsRouter.post('/', requireRole(Role.SALES, Role.SUPER_ADMIN), async (req: AuthRequest, res) => {
  try {
    const { listingId, data } = CreateCollectionSchema.parse(req.body)
    const authorId = req.user!.id

    const collection = await prisma.collection.create({
      data: {
        listingId,
        data,
        authorId,
        updatedAt: new Date(),
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
    const { listingId, data } = UpdateCollectionSchema.parse(req.body)

    // Parse ID - could be integer ID or string listingId
    const numericId = parseInt(id, 10)
    const where = !isNaN(numericId) ? { id: numericId } : { listingId: id }

    const collection = await prisma.collection.update({
      where,
      data: {
        ...(listingId ? { listingId } : {}),
        ...(data ? { data } : {}),
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

    // Parse ID - could be integer ID or string listingId
    const numericId = parseInt(id, 10)
    const where = !isNaN(numericId) ? { id: numericId } : { listingId: id }

    // Get collection to extract image URLs for S3 cleanup
    const collection = await prisma.collection.findUnique({
      where,
      select: { data: true }
    })

    if (!collection || !collection.data) {
      return res.status(404).json({ success: false, error: 'Collection not found' })
    }

    const storedData = collection.data as Record<string, any>
    const images: string[] = Array.isArray(storedData?.images) ? storedData.images : []

    // Delete images from S3
    if (images.length > 0) {
      const keys = images
        .map((url) => s3Service.extractKeyFromUrl(url))
        .filter((key): key is string => Boolean(key))
      await s3Service.deleteObjects(keys)
    }

    // Delete collection from database
    await prisma.collection.delete({
      where
    })

    return res.status(204).end()
  } catch (error) {
    console.error('Delete collection error:', error)
    return res.status(500).json({ success: false, error: 'Failed to delete collection' })
  }
})
