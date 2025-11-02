import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { env } from './config/env'
import { authRouter } from './routes/auth'
import { usersRouter } from './routes/users'
import { collectionsRouter } from './routes/collections'
import { inspectionsRouter } from './routes/inspections'
import { carRecordsRouter } from './routes/car-records'
import { companiesRouter } from './routes/companies'
import { portInfosRouter } from './routes/port-infos'
import { invoicesRouter } from './routes/invoices'

const app = express()
app.use(helmet())
app.use(cors({ 
  origin: env.CORS_ORIGIN, 
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))
app.use(express.json({ limit: '10mb' }))
app.use(rateLimit({ windowMs: 60_000, max: 200 }))

const API_PREFIX = '/api/v1'

app.use(`${API_PREFIX}/auth`, authRouter)
app.use(`${API_PREFIX}/users`, usersRouter)
app.use(`${API_PREFIX}/collections`, collectionsRouter)
app.use(`${API_PREFIX}/inspections`, inspectionsRouter)
app.use(`${API_PREFIX}/car-records`, carRecordsRouter)
app.use(`${API_PREFIX}/companies`, companiesRouter)
app.use(`${API_PREFIX}/port-infos`, portInfosRouter)
app.use(`${API_PREFIX}/invoices`, invoicesRouter)

app.get(`${API_PREFIX}/health`, (_req, res) => res.json({ ok: true }))

app.listen(Number(env.PORT), () => {
  console.log(`Backend running on http://localhost:${env.PORT}${API_PREFIX}`)
})


