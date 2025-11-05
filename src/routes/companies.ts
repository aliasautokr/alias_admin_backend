import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole, AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { s3Service } from '../lib/s3'
import { Prisma, Role } from '@prisma/client'

export const companiesRouter = Router()

// Validation schemas
const CreateCompanySchema = z.object({
  name: z.string().min(1).max(255),
  address: z.string().min(1),
  phone: z.string().min(1),
  logoUrl: z.string().url().optional(),
  sealUrl: z.string().url().optional(),
})

const UpdateCompanySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  address: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  logoUrl: z.string().url().optional(),
  sealUrl: z.string().url().optional(),
})

const UploadUrlSchema = z.object({
  fileName: z.string().min(1),
  fileType: z.string().min(1),
})

// Middleware to check if user owns the company or is SUPER_ADMIN
const requireOwnerOrAdmin = async (req: AuthRequest, res: any, next: any) => {
  const { id } = req.params
  const userId = req.user?.id
  const userRole = req.user?.role

  if (userRole === Role.SUPER_ADMIN) {
    return next()
  }

  try {
    const company = await prisma.company.findUnique({
      where: { id },
      select: { authorId: true }
    })

    if (!company) {
      return res.status(404).json({ success: false, error: 'Company not found' })
    }

    if (company.authorId !== userId) {
      return res.status(403).json({ success: false, error: 'Forbidden' })
    }

    next()
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
}

companiesRouter.use(requireAuth)

// POST /api/v1/companies/upload-url - Generate presigned URL for logo/seal upload
companiesRouter.post('/upload-url', async (req: AuthRequest, res) => {
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

// GET /api/v1/companies - List all companies
companiesRouter.get('/', requireRole(Role.SUPER_ADMIN, Role.SALES), async (req: AuthRequest, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 10
    const authorId = req.query.authorId as string
    const skip = (page - 1) * limit

    const where: Prisma.CompanyWhereInput = {}
    if (authorId) {
      where.authorId = authorId
    }

    const [companies, total] = await Promise.all([
      prisma.company.findMany({
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
      prisma.company.count({ where })
    ])

    return res.json({
      success: true,
      data: {
        items: companies,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        }
      }
    })
  } catch (error) {
    console.error('List companies error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch companies' })
  }
})

// GET /api/v1/companies/:id - Get single company
companiesRouter.get('/:id', requireRole(Role.SUPER_ADMIN, Role.SALES), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    const company = await prisma.company.findUnique({
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

    if (!company) {
      return res.status(404).json({ success: false, error: 'Company not found' })
    }

    return res.json({
      success: true,
      data: company
    })
  } catch (error) {
    console.error('Get company error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch company' })
  }
})

// POST /api/v1/companies - Create company
companiesRouter.post('/', requireRole(Role.SALES, Role.SUPER_ADMIN), async (req: AuthRequest, res) => {
  try {
    const { name, address, phone, logoUrl, sealUrl } = CreateCompanySchema.parse(req.body)
    const authorId = req.user!.id

    const company = await prisma.company.create({
      data: {
        name,
        address,
        phone,
        logoUrl: logoUrl || null,
        sealUrl: sealUrl || null,
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
      data: company
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.errors })
    }
    console.error('Create company error:', error)
    return res.status(500).json({ success: false, error: 'Failed to create company' })
  }
})

// PATCH /api/v1/companies/:id - Update company
companiesRouter.patch('/:id', requireOwnerOrAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params
    const updateData = UpdateCompanySchema.parse(req.body)

    const company = await prisma.company.update({
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
      data: company
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.errors })
    }
    console.error('Update company error:', error)
    return res.status(500).json({ success: false, error: 'Failed to update company' })
  }
})

// DELETE /api/v1/companies/:id - Delete company
companiesRouter.delete('/:id', requireOwnerOrAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    // Get company to extract image URLs for S3 cleanup
    const company = await prisma.company.findUnique({
      where: { id },
      select: { logoUrl: true, sealUrl: true }
    })

    if (!company) {
      return res.status(404).json({ success: false, error: 'Company not found' })
    }

    // Delete logo and seal from S3 if they exist
    if (company.logoUrl) {
      try {
        const logoKey = s3Service.extractKeyFromUrl(company.logoUrl)
        await s3Service.deleteObject(logoKey)
      } catch (error) {
        console.error('Failed to delete logo from S3:', error)
      }
    }

    if (company.sealUrl) {
      try {
        const sealKey = s3Service.extractKeyFromUrl(company.sealUrl)
        await s3Service.deleteObject(sealKey)
      } catch (error) {
        console.error('Failed to delete seal from S3:', error)
      }
    }

    // Delete company from database
    await prisma.company.delete({
      where: { id }
    })

    return res.status(204).end()
  } catch (error) {
    console.error('Delete company error:', error)
    return res.status(500).json({ success: false, error: 'Failed to delete company' })
  }
})

