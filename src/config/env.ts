import 'dotenv/config'
import { z } from 'zod'

const EnvSchema = z.object({
  PORT: z.string().default('5000'),
  DATABASE_URL: z.string(),
  JWT_ACCESS_SECRET: z.string(),
  JWT_REFRESH_SECRET: z.string(),
  GOOGLE_CLIENT_ID: z.string(),
  CORS_ORIGIN: z.string().default('http://localhost:3002'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_S3_BUCKET: z.string().optional(),
})

export const env = EnvSchema.parse(process.env)


