import { Router } from 'express'
import { prisma } from '../lib/prisma'
import { s3Service } from '../lib/s3'

export const publicInspectionsRouter = Router()

// GET /api/v1/public/inspections/:inspectionId - Get single inspection by inspectionId
publicInspectionsRouter.get('/:inspectionId', async (req, res) => {
  try {
    const { inspectionId } = req.params

    if (!inspectionId) {
      return res.status(400).json({ success: false, error: 'Inspection ID is required' })
    }

    const inspection = await prisma.inspection.findUnique({
      where: { inspectionId } as any,
      select: {
        id: true,
        inspectionId: true,
        title: true,
        images: true,
        description: true,
        customerName: true,
        inspectorName: true,
        link: true,
        createdAt: true,
        updatedAt: true,
      } as any
    })

    if (!inspection) {
      return res.status(404).json({ success: false, error: 'Inspection not found' })
    }

    const inspectionData = inspection as any

    // Generate presigned URLs for images so they can be accessed publicly
    const imagesWithPresignedUrls = await Promise.all(
      (inspectionData.images || []).map(async (imageUrl: string) => {
        try {
          // Extract key from S3 URL (format: https://bucket.s3.region.amazonaws.com/key)
          const key = imageUrl.split('.com/')[1]
          if (key) {
            // Generate presigned URL with 1 hour expiration
            const presignedUrl = await s3Service.generatePresignedGetUrl(key, 3600)
            return presignedUrl
          }
          return imageUrl // Fallback to original URL
        } catch (error) {
          console.error('Error generating presigned URL for image:', error)
          return imageUrl // Fallback to original URL
        }
      })
    )

    return res.json({
      success: true,
      data: {
        ...inspectionData,
        images: imagesWithPresignedUrls,
      }
    })
  } catch (error) {
    console.error('Get public inspection error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch inspection' })
  }
})

