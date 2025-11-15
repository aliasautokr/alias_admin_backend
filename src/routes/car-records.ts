import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole, AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { Prisma, Role } from '@prisma/client'
import crypto from 'crypto'

export const carRecordsRouter = Router()

// Helper functions to sanitize data - extract only numbers
function sanitizeWeight(weight: string): string {
  // Extract only numbers and decimal point, remove all other characters (kg, spaces, etc.)
  return weight.replace(/[^\d.]/g, '').trim()
}

function sanitizeManufactureDate(date: string): string {
  // Extract only numbers, remove all text characters (년, 월, -, spaces, etc.)
  // Then take only the first 4 digits (year) and remove month/day
  const numbersOnly = date.replace(/[^\d]/g, '').trim()
  return numbersOnly.substring(0, 4) || numbersOnly // Take only first 4 digits (year)
}

// Validation schemas
const CreateCarRecordSchema = z.object({
  vin: z.string().min(1).max(255),
  car_model: z.string().min(1).max(255),
  engine_cc: z.string().min(1).max(50),
  weight: z.string().min(1).max(100),
  manufacture_date: z.string().min(1).max(50),
  price: z.string().min(1).max(100),
  fuel_type: z.enum(['Hybrid', 'Diesel', 'Gasoline']).default('Gasoline'),
})

const UpdateCarRecordSchema = z.object({
  vin: z.string().min(1).max(255).optional(),
  car_model: z.string().min(1).max(255).optional(),
  engine_cc: z.string().min(1).max(50).optional(),
  weight: z.string().min(1).max(100).optional(),
  manufacture_date: z.string().min(1).max(50).optional(),
  price: z.string().min(1).max(100).optional(),
  fuel_type: z.enum(['Hybrid', 'Diesel', 'Gasoline']).optional(),
})

// Middleware to check if user owns the car record or is SUPER_ADMIN
const requireOwnerOrAdmin = async (req: AuthRequest, res: any, next: any) => {
  const { id } = req.params
  const userId = req.user?.id
  const userRole = req.user?.role

  if (userRole === Role.SUPER_ADMIN) {
    return next()
  }

  try {
    const carRecord = await prisma.carRecord.findUnique({
      where: { id },
      select: { authorId: true }
    })

    if (!carRecord) {
      return res.status(404).json({ success: false, error: 'Car record not found' })
    }

    if (carRecord.authorId !== userId) {
      return res.status(403).json({ success: false, error: 'Forbidden' })
    }

    next()
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
}

carRecordsRouter.use(requireAuth)

// GET /api/v1/car-records/latest - Get last entered car record
carRecordsRouter.get('/latest', requireRole(Role.SUPER_ADMIN, Role.SALES), async (req: AuthRequest, res) => {
  try {
    const carRecord = await prisma.carRecord.findFirst({
      orderBy: { createdAt: 'desc' },
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

    if (!carRecord) {
      return res.status(404).json({ success: false, error: 'No car records found' })
    }

    return res.json({
      success: true,
      data: carRecord
    })
  } catch (error) {
    console.error('Get latest car record error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch latest car record' })
  }
})

// GET /api/v1/car-records/search?vinLastDigits=xxxx - Search car records by last 4, 5, or 6 digits of VIN
carRecordsRouter.get('/search', requireRole(Role.SUPER_ADMIN, Role.SALES), async (req: AuthRequest, res) => {
  try {
    const vinLastDigits = req.query.vinLastDigits as string
    
    if (!vinLastDigits || vinLastDigits.length < 4 || vinLastDigits.length > 6) {
      return res.status(400).json({ 
        success: false, 
        error: 'vinLastDigits must be between 4 and 6 digits' 
      })
    }

    // Search for VINs ending with the provided digits (4, 5, or 6)
    const carRecords = await prisma.carRecord.findMany({
      where: {
        vin: {
          endsWith: vinLastDigits,
        },
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
      },
      orderBy: { createdAt: 'desc' },
      take: 10, // Limit to 10 results
    })

    return res.json({
      success: true,
      data: {
        items: carRecords,
        count: carRecords.length,
      }
    })
  } catch (error) {
    console.error('Search car records error:', error)
    return res.status(500).json({ success: false, error: 'Failed to search car records' })
  }
})

// GET /api/v1/car-records - List all car records
carRecordsRouter.get('/', requireRole(Role.SUPER_ADMIN, Role.SALES), async (req: AuthRequest, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 10
    const authorId = req.query.authorId as string
    const skip = (page - 1) * limit

    const where: Prisma.CarRecordWhereInput = {}
    if (authorId) {
      where.authorId = authorId
    }

    const [carRecords, total] = await Promise.all([
      prisma.carRecord.findMany({
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
      prisma.carRecord.count({ where })
    ])

    return res.json({
      success: true,
      data: {
        items: carRecords,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        }
      }
    })
  } catch (error) {
    console.error('List car records error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch car records' })
  }
})

// GET /api/v1/car-records/:id - Get single car record
carRecordsRouter.get('/:id', requireRole(Role.SUPER_ADMIN, Role.SALES), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    const carRecord = await prisma.carRecord.findUnique({
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

    if (!carRecord) {
      return res.status(404).json({ success: false, error: 'Car record not found' })
    }

    return res.json({
      success: true,
      data: carRecord
    })
  } catch (error) {
    console.error('Get car record error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch car record' })
  }
})

// POST /api/v1/car-records - Create car record
carRecordsRouter.post('/', requireRole(Role.SALES, Role.SUPER_ADMIN), async (req: AuthRequest, res) => {
  try {
    const { vin, car_model, engine_cc, weight, manufacture_date, price, fuel_type } = CreateCarRecordSchema.parse(req.body)
    const authorId = req.user!.id

    // Sanitize weight and manufacture_date to store only numbers
    const sanitizedWeight = sanitizeWeight(weight)
    const sanitizedManufactureDate = sanitizeManufactureDate(manufacture_date)

    const carRecord = await prisma.carRecord.create({
      data: {
        id: crypto.randomUUID(),
        vin,
        car_model,
        engine_cc,
        weight: sanitizedWeight,
        manufacture_date: sanitizedManufactureDate,
        price,
        fuel_type: fuel_type || 'Gasoline',
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
      data: carRecord
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.errors })
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'VIN already exists' })
    }
    console.error('Create car record error:', error)
    return res.status(500).json({ success: false, error: 'Failed to create car record' })
  }
})

// PATCH /api/v1/car-records/:id - Update car record
carRecordsRouter.patch('/:id', requireOwnerOrAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params
    const parsedData = UpdateCarRecordSchema.parse(req.body)

    // Filter out undefined values before passing to Prisma
    const updateData: any = {}
    if (parsedData.vin !== undefined) updateData.vin = parsedData.vin
    if (parsedData.car_model !== undefined) updateData.car_model = parsedData.car_model
    if (parsedData.engine_cc !== undefined) updateData.engine_cc = parsedData.engine_cc
    if (parsedData.weight !== undefined) updateData.weight = sanitizeWeight(parsedData.weight)
    if (parsedData.manufacture_date !== undefined) updateData.manufacture_date = sanitizeManufactureDate(parsedData.manufacture_date)
    if (parsedData.price !== undefined) updateData.price = parsedData.price
    if (parsedData.fuel_type !== undefined) updateData.fuel_type = parsedData.fuel_type

    // If no fields to update, return error
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' })
    }

    const carRecord = await prisma.carRecord.update({
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
      data: carRecord
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Update car record validation error:', error.errors)
      return res.status(400).json({ success: false, error: error.errors })
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'VIN already exists' })
    }
    console.error('Update car record error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Failed to update car record'
    return res.status(500).json({ success: false, error: errorMessage })
  }
})

// DELETE /api/v1/car-records/:id - Delete car record
carRecordsRouter.delete('/:id', requireOwnerOrAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    await prisma.carRecord.delete({
      where: { id }
    })

    return res.status(204).end()
  } catch (error) {
    console.error('Delete car record error:', error)
    return res.status(500).json({ success: false, error: 'Failed to delete car record' })
  }
})

