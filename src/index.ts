import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { env } from './config/env'
import { authRouter } from './routes/auth'
import { usersRouter } from './routes/users'
import { collectionsRouter } from './routes/collections'
import { publicCollectionsRouter } from './routes/public-collections'
import { inspectionsRouter } from './routes/inspections'
import { carRecordsRouter } from './routes/car-records'
import { companiesRouter } from './routes/companies'
import { portInfosRouter } from './routes/port-infos'
import { invoicesRouter } from './routes/invoices'
import { invoiceTemplatesRouter } from './routes/invoice-templates'

const app = express()
app.use(helmet())
app.use(cors({ 
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true)
    
    // Parse allowed origins from CORS_ORIGIN (comma-separated)
    const allowedOrigins = env.CORS_ORIGIN.split(',').map(o => o.trim())
    
    // Also allow common production domains
    const defaultAllowed = [
      'https://admin.aliasauto.kr',
      'https://aliasauto.kr',
      'https://www.aliasauto.kr',
      'http://localhost:3002',
      'http://localhost:3000',
    ]
    
    const allAllowed = [...allowedOrigins, ...defaultAllowed]
    
    if (allAllowed.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))
app.use(express.json({ limit: '10mb' }))
app.use(rateLimit({ windowMs: 60_000, max: 200 }))

const API_PREFIX = '/api/v1'

// Public routes (no authentication)
app.use(`${API_PREFIX}/public/collections`, publicCollectionsRouter)

// Protected routes (authentication required)
app.use(`${API_PREFIX}/auth`, authRouter)
app.use(`${API_PREFIX}/users`, usersRouter)
app.use(`${API_PREFIX}/collections`, collectionsRouter)
app.use(`${API_PREFIX}/inspections`, inspectionsRouter)
app.use(`${API_PREFIX}/car-records`, carRecordsRouter)
app.use(`${API_PREFIX}/companies`, companiesRouter)
app.use(`${API_PREFIX}/port-infos`, portInfosRouter)
app.use(`${API_PREFIX}/invoices`, invoicesRouter)
app.use(`${API_PREFIX}/invoice-templates`, invoiceTemplatesRouter)

app.get(`${API_PREFIX}/health`, (_req, res) => res.json({ ok: true }))

const server = app.listen(Number(env.PORT), () => {
  console.log(`Backend running on http://localhost:${env.PORT}${API_PREFIX}`)
})

// Graceful shutdown handling for tsx watch
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server')
  server.close(() => {
    console.log('HTTP server closed')
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server')
  server.close(() => {
    console.log('HTTP server closed')
    process.exit(0)
  })
})


