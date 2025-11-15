import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole, AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { s3Service } from '../lib/s3'
import { Role } from '@prisma/client'
import crypto from 'crypto'

export const invoiceTemplatesRouter = Router()

const UploadUrlSchema = z.object({
  fileName: z.string().min(1),
  fileType: z.string().min(1),
})

const CreateTemplateSchema = z.object({
  fileName: z.string().min(1),
  fileUrl: z.string().url(),
  s3Key: z.string().min(1),
})

const allowedDocTypes = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // legacy .doc
])

invoiceTemplatesRouter.use(requireAuth)

invoiceTemplatesRouter.post('/upload-url', requireRole(Role.SUPER_ADMIN, Role.SALES), async (req: AuthRequest, res) => {
  try {
    const { fileName, fileType } = UploadUrlSchema.parse(req.body)

    if (!allowedDocTypes.has(fileType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid file type. Only .docx (Word) files are allowed.',
      })
    }

    const userId = req.user!.id
    const key = s3Service.generateUniqueKey(fileName, userId, 'InvoiceTemplates')

    const { uploadUrl, imageUrl: fileUrl, key: s3Key } = await s3Service.generatePresignedUploadUrl(
      key,
      fileType,
      900,
    )

    return res.json({
      success: true,
      data: {
        uploadUrl,
        fileUrl,
        key: s3Key,
      },
    })
  } catch (error) {
    console.error('Invoice template upload URL error:', error)
    return res.status(500).json({ success: false, error: 'Failed to generate upload URL' })
  }
})

invoiceTemplatesRouter.post('/', requireRole(Role.SUPER_ADMIN, Role.SALES), async (req: AuthRequest, res) => {
  try {
    const { fileName, fileUrl, s3Key } = CreateTemplateSchema.parse(req.body)

    const template = await prisma.invoiceTemplate.create({
      data: {
        id: crypto.randomUUID(),
        fileName,
        fileUrl,
        s3Key,
        uploadedById: req.user!.id,
      },
      include: {
        uploadedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    })

    return res.json({ success: true, data: template })
  } catch (error) {
    console.error('Invoice template create error:', error)
    return res.status(500).json({ success: false, error: 'Failed to save invoice template' })
  }
})

invoiceTemplatesRouter.get('/', requireRole(Role.SUPER_ADMIN, Role.SALES), async (_req: AuthRequest, res) => {
  try {
    const templates = await prisma.invoiceTemplate.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        uploadedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    })

    return res.json({ success: true, data: templates })
  } catch (error) {
    console.error('Invoice template list error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch invoice templates' })
  }
})

invoiceTemplatesRouter.delete('/:id', requireRole(Role.SUPER_ADMIN), async (req: AuthRequest, res) => {
  const { id } = req.params

  try {
    const template = await prisma.invoiceTemplate.findUnique({ where: { id } })
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found' })
    }

    await Promise.all([
      s3Service.deleteObject(template.s3Key),
      prisma.invoiceTemplate.delete({ where: { id } }),
    ])

    return res.json({ success: true })
  } catch (error) {
    console.error('Invoice template delete error:', error)
    return res.status(500).json({ success: false, error: 'Failed to delete invoice template' })
  }
})

