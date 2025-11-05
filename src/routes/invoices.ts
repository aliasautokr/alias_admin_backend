import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole, AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { s3Service } from '../lib/s3'
import { Prisma, Role } from '@prisma/client'

export const invoicesRouter = Router()

// Country code mapping
const COUNTRY_CODE_MAP: Record<string, string> = {
  'Russia': 'RU',
  'Uzbekistan': 'UZ',
  'Kazakhstan': 'KZ',
  'Kyrgyzstan': 'KG',
}

/**
 * Generate invoice number in format: {COUNTRY_CODE}-{YYYYMMDD}{SEQUENCE}
 * Example: RU-2025112001 (country code separated from date, but date and sequence together)
 */
async function generateInvoiceNumber(country: string, date: Date): Promise<string> {
  // Get country code
  const countryCode = COUNTRY_CODE_MAP[country] || country.substring(0, 2).toUpperCase()
  
  // Format date as YYYYMMDD
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const dateStr = `${year}${month}${day}`
  
  // Find start and end of the day
  const startOfDay = new Date(date)
  startOfDay.setHours(0, 0, 0, 0)
  const endOfDay = new Date(date)
  endOfDay.setHours(23, 59, 59, 999)
  
  // Count existing invoices for this country on this date
  const count = await prisma.invoice.count({
    where: {
      country: country,
      date: {
        gte: startOfDay,
        lte: endOfDay,
      },
    },
  })
  
  // Sequence number is count + 1, padded to 2 digits
  const sequence = String(count + 1).padStart(2, '0')
  
  return `${countryCode}-${dateStr}${sequence}`
}

// Validation schemas
const CreateInvoiceSchema = z.object({
  companyId: z.string().min(1),
  portInfoId: z.string().min(1),
  country: z.string().min(1),
  carRecordId: z.string().optional(), // Optional car record ID
  buyer: z.object({
    country: z.string(),
    consignee_name: z.string(),
    consignee_address: z.string(),
    consignee_iin: z.string(),
    consignee_tel: z.string(),
  }),
})

// Middleware to check if user owns the invoice or is SUPER_ADMIN
const requireOwnerOrAdmin = async (req: AuthRequest, res: any, next: any) => {
  const { id } = req.params
  const userId = req.user?.id
  const userRole = req.user?.role

  if (userRole === Role.SUPER_ADMIN) {
    return next()
  }

  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: { authorId: true }
    })

    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' })
    }

    if (invoice.authorId !== userId) {
      return res.status(403).json({ success: false, error: 'Forbidden' })
    }

    next()
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
}

invoicesRouter.use(requireAuth)

// POST /api/v1/invoices/generate-consignee - Generate consignee data from Python server
invoicesRouter.post('/generate-consignee', async (req, res) => {
  try {
    const { country } = req.body

    if (!country) {
      return res.status(400).json({ success: false, error: 'Country is required' })
    }

    console.log('Generating consignee for country:', country)

    // Call Python server directly with timeout
    const pythonServerUrl = 'http://43.200.233.218:8000'
    
    // Create AbortController for timeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 30000) // 30 second timeout
    
    try {
      const response = await fetch(`${pythonServerUrl}/api/generate-consignee`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ country }),
        signal: controller.signal, // Add abort signal for timeout
      })
      
      clearTimeout(timeoutId) // Clear timeout if request succeeds

      if (!response.ok) {
        const errorText = await response.text()
        console.error('Python server error response:', errorText)
        return res.status(response.status).json({
          success: false,
          error: errorText || 'Failed to generate consignee'
        })
      }

      const pythonResponse = await response.json()
      console.log('Python server response:', JSON.stringify(pythonResponse, null, 2))
      
      // Python server returns: { "country": "...", "data": { "consignee_name": "...", ... } }
      // Return in format expected by frontend
      return res.json({
        success: true,
        data: pythonResponse.data || pythonResponse
      })
    } catch (fetchError: any) {
      clearTimeout(timeoutId) // Clear timeout on error
      
      // Check if error is due to timeout/abort
      if (fetchError.name === 'AbortError' || fetchError.message?.includes('aborted')) {
        console.error('Python server request timed out after 30 seconds')
        return res.status(504).json({
          success: false,
          error: 'Request to Python server timed out. Please try again.'
        })
      }
      
      // Re-throw to be caught by outer catch
      throw fetchError
    }
  } catch (error: any) {
    console.error('Generate consignee error:', error)
    
    // Handle network errors
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      return res.status(503).json({
        success: false,
        error: 'Python server is unavailable. Please try again later.'
      })
    }
    
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to generate consignee'
    })
  }
})

// GET /api/v1/invoices - List all invoices
invoicesRouter.get('/', requireRole(Role.SUPER_ADMIN, Role.SALES), async (req: AuthRequest, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 10
    const authorId = req.query.authorId as string
    const skip = (page - 1) * limit

    const where: Prisma.InvoiceWhereInput = {}
    if (authorId) {
      where.authorId = authorId
    }

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: {
          author: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            }
          },
          carRecord: {
            select: {
              id: true,
              vin: true,
              car_model: true,
              engine_cc: true,
              weight: true,
              manufacture_date: true,
              price: true,
              fuel_type: true,
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.invoice.count({ where })
    ])

    return res.json({
      success: true,
      data: {
        items: invoices,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        }
      }
    })
  } catch (error) {
    console.error('List invoices error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch invoices' })
  }
})

// GET /api/v1/invoices/:id - Get single invoice
invoicesRouter.get('/:id', requireRole(Role.SUPER_ADMIN, Role.SALES), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          }
        },
        carRecord: {
          select: {
            id: true,
            vin: true,
            car_model: true,
            engine_cc: true,
            weight: true,
            manufacture_date: true,
            price: true,
            fuel_type: true,
          }
        }
      }
    })

    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' })
    }

    return res.json({
      success: true,
      data: invoice
    })
  } catch (error) {
    console.error('Get invoice error:', error)
    return res.status(500).json({ success: false, error: 'Failed to fetch invoice' })
  }
})

// POST /api/v1/invoices - Create invoice with Word generation
invoicesRouter.post('/', requireRole(Role.SALES, Role.SUPER_ADMIN), async (req: AuthRequest, res) => {
  try {
    const { companyId, portInfoId, country, carRecordId, buyer } = CreateInvoiceSchema.parse(req.body)
    const authorId = req.user!.id

    // Generate invoice number: {COUNTRY_CODE}-{YYYYMMDD}-{SEQUENCE}
    const invoiceDate = new Date()
    const invoiceNumber = await generateInvoiceNumber(country, invoiceDate)

    // Fetch full company data
    const company = await prisma.company.findUnique({
      where: { id: companyId }
    })

    if (!company) {
      return res.status(404).json({ success: false, error: 'Company not found' })
    }

    // Fetch full port info data
    const portInfo = await prisma.portInfo.findUnique({
      where: { id: portInfoId }
    })

    if (!portInfo) {
      return res.status(404).json({ success: false, error: 'Port info not found' })
    }

    // Fetch car record data if carRecordId is provided
    let carRecord = null
    if (carRecordId) {
      carRecord = await prisma.carRecord.findUnique({
        where: { id: carRecordId }
      })
    }

    // Prepare invoice data for Python backend Word generation
    // Map country names to official country names
    const countryNameMap: Record<string, string> = {
      'Russia': 'Russian Federation',
      'Uzbekistan': 'Republic of Uzbekistan',
      'Kazakhstan': 'Republic of Kazakhstan',
      'Kyrgyzstan': 'Kyrgyz Republic',
    }
    const officialCountryName = countryNameMap[buyer.country] || buyer.country || ''
    
    // Use fuel_type from car record (saved in database)
    const fuelType = carRecord?.fuel_type || 'Gasoline'
    
    const invoiceData = {
      // Shipper info (Company)
      shipper_name: company.name || '',
      shipper_address: company.address || '',
      shipper_tel: company.phone || '',
      
      // Invoice info
      invoice_no: invoiceNumber,
      invoice_date: invoiceDate.toISOString().split('T')[0], // Format as YYYY-MM-DD
      
      // Destination - Buyer Country (official country name)
      destination: officialCountryName,
      
      // Consignee info (Buyer)
      consignee_name: buyer.consignee_name || '',
      consignee_address: buyer.consignee_address || '',
      consignee_tel: buyer.consignee_tel || '',
      consignee_iin: buyer.consignee_iin || '',
      
      // Origin country - Always South Korea
      origin_country: 'South Korea',
      
      // Port info
      port_name: portInfo.shortAddress || '', // Port short address
      port_loading: portInfo.description || '', // Port full address (description field)
      
      // Sailing date - Today date
      sailing_date: invoiceDate.toISOString().split('T')[0], // Format as YYYY-MM-DD
      
      // Car info - use car record data if available, otherwise empty
      car_vin: carRecord?.vin || '',
      car_model: carRecord?.car_model || '',
      // Extract year only (number) from manufacture_date - handles formats like "2025-04" or "2025"
      car_year: carRecord?.manufacture_date 
        ? carRecord.manufacture_date.split('-')[0].trim().replace(/\D/g, '').slice(0, 4)
        : '',
      volume: carRecord?.engine_cc || '', // engine_cc maps to volume
      // Extract only numeric value from weight - remove all non-numeric characters except decimal point
      weight: carRecord?.weight 
        ? String(carRecord.weight).replace(/[^\d.]/g, '').trim()
        : '',
      fuel_type: fuelType, // Hybrid, Diesel, or Gasoline
      unit_price: carRecord?.price || '',
      
      // Images - note: Python backend expects logo_image and seal_image, not logo_url/seal_url
      logo_image: company.logoUrl || '',
      seal_image: company.sealUrl || '',
    }

    console.log('=== CALLING PYTHON BACKEND FOR WORD GENERATION ===')
    console.log('Invoice data:', JSON.stringify(invoiceData, null, 2))

    // Call Python backend API to generate Word document
    const pythonServerUrl = 'http://43.200.233.218:8000'
    let fileUrl: string
    
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 60000) // 60 second timeout for Word generation
      
      try {
        const response = await fetch(`${pythonServerUrl}/api/generate-docx`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(invoiceData),
          signal: controller.signal,
        })
        
        clearTimeout(timeoutId)

        if (!response.ok) {
          const errorText = await response.text()
          console.error('Python server error response:', errorText)
          return res.status(response.status).json({
            success: false,
            error: errorText || 'Failed to generate Word document'
          })
        }

        const pythonResponse = await response.json()
        console.log('Python server response:', JSON.stringify(pythonResponse, null, 2))
        
        // Python server returns: { "message": "...", "download_url": "..." }
        fileUrl = pythonResponse.download_url
        
        if (!fileUrl) {
          return res.status(500).json({
            success: false,
            error: 'Python server did not return download_url in response'
          })
        }
        
        console.log('✅ Word document generated successfully:', fileUrl)
      } catch (fetchError: any) {
        clearTimeout(timeoutId)
        
        if (fetchError.name === 'AbortError' || fetchError.message?.includes('aborted')) {
          console.error('Python server request timed out after 60 seconds')
          return res.status(504).json({
            success: false,
            error: 'Word generation request timed out. Please try again.'
          })
        }
        
        throw fetchError
      }
    } catch (error: any) {
      console.error('Word generation error:', error)
      
      // Handle network errors
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        return res.status(503).json({
          success: false,
          error: 'Python server is unavailable. Please try again later.'
        })
      }
      
      return res.status(500).json({
        success: false,
        error: `Failed to generate Word document: ${error?.message || 'Unknown error'}`
      })
    }

    // Store full invoice data as JSON (include car record for VIN access)
    const invoiceJsonData = {
      company,
      portInfo,
      buyer,
      carRecord: carRecord ? {
        id: carRecord.id,
        vin: carRecord.vin,
        car_model: carRecord.car_model,
        engine_cc: carRecord.engine_cc,
        weight: carRecord.weight,
        manufacture_date: carRecord.manufacture_date,
        price: carRecord.price,
        fuel_type: carRecord.fuel_type,
      } : null,
      // Also include car_vin for easy access
      car_vin: carRecord?.vin || '',
    }

    // Create invoice record with car information
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber,
        date: invoiceDate,
        country,
        fileUrl,
        data: invoiceJsonData as any,
        // Car information fields
        carRecordId: carRecord?.id || null,
        carVin: carRecord?.vin || null,
        carModel: carRecord?.car_model || null,
        carYear: carRecord?.manufacture_date 
          ? carRecord.manufacture_date.split('-')[0].trim().replace(/\D/g, '').slice(0, 4)
          : null,
        carWeight: carRecord?.weight || null,
        carVolume: carRecord?.engine_cc || null,
        carPrice: carRecord?.price || null,
        carFuelType: fuelType || null,
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
        },
        carRecord: {
          select: {
            id: true,
            vin: true,
            car_model: true,
            engine_cc: true,
            weight: true,
            manufacture_date: true,
            price: true,
            fuel_type: true,
          }
        }
      }
    })

    return res.status(201).json({
      success: true,
      data: invoice
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.errors })
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'Invoice number already exists' })
    }
    console.error('Create invoice error:', error)
    return res.status(500).json({ success: false, error: 'Failed to create invoice' })
  }
})

// DELETE /api/v1/invoices/:id - Delete invoice
invoicesRouter.delete('/:id', requireOwnerOrAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    // Get invoice to extract file URL for S3 cleanup
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: { fileUrl: true }
    })

    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' })
    }

    // Delete Word file from S3 if it exists
    if (invoice.fileUrl) {
      try {
        const fileKey = s3Service.extractKeyFromUrl(invoice.fileUrl)
        await s3Service.deleteObject(fileKey)
      } catch (error) {
        console.error('Failed to delete invoice file from S3:', error)
      }
    }

    // Delete invoice from database
    await prisma.invoice.delete({
      where: { id }
    })

    return res.status(204).end()
  } catch (error) {
    console.error('Delete invoice error:', error)
    return res.status(500).json({ success: false, error: 'Failed to delete invoice' })
  }
})

