import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '../config/env'

const s3Client = new S3Client({
  region: env.AWS_REGION,
  credentials: env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  } : undefined,
})

export class S3Service {
  private static instance: S3Service
  private client: S3Client

  constructor() {
    this.client = s3Client
  }

  static getInstance(): S3Service {
    if (!S3Service.instance) {
      S3Service.instance = new S3Service()
    }
    return S3Service.instance
  }

  /**
   * Generate a presigned URL for uploading a file to S3
   * @param key - The S3 object key (file path)
   * @param contentType - The MIME type of the file
   * @param expiresIn - URL expiration time in seconds (default: 900 = 15 minutes)
   * @returns Promise<{ uploadUrl: string, imageUrl: string, key: string }>
   */
  async generatePresignedUploadUrl(
    key: string,
    contentType: string,
    expiresIn: number = 900
  ): Promise<{ uploadUrl: string; imageUrl: string; key: string }> {
    if (!env.AWS_S3_BUCKET) {
      throw new Error('AWS S3 bucket not configured')
    }

    const command = new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
      Key: key,
      ContentType: contentType,
    })

    const uploadUrl = await getSignedUrl(this.client, command, { expiresIn })
    // Return the public S3 URL for storage
    const imageUrl = `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`

    return {
      uploadUrl,
      imageUrl,
      key,
    }
  }

  /**
   * Generate a presigned URL for downloading/viewing a file from S3
   * @param key - The S3 object key
   * @param expiresIn - URL expiration time in seconds (default: 3600 = 1 hour)
   * @returns Promise<string>
   */
  async generatePresignedGetUrl(key: string, expiresIn: number = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
      Key: key,
    })

    return await getSignedUrl(this.client, command, { expiresIn })
  }

  /**
   * Delete an object from S3
   * @param key - The S3 object key to delete
   * @returns Promise<void>
   */
  async deleteObject(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
      Key: key,
    })

    await this.client.send(command)
  }

  /**
   * Delete multiple objects from S3
   * @param keys - Array of S3 object keys to delete
   * @returns Promise<void>
   */
  async deleteObjects(keys: string[]): Promise<void> {
    const deletePromises = keys.map(key => this.deleteObject(key))
    await Promise.all(deletePromises)
  }

  /**
   * Extract S3 key from a full S3 URL
   * @param s3Url - Full S3 URL
   * @returns string - The S3 key
   */
  extractKeyFromUrl(s3Url: string): string {
    const url = new URL(s3Url)
    return url.pathname.substring(1) // Remove leading slash
  }

  /**
   * Generate a unique key for an uploaded file
   * @param fileName - Original file name
   * @param userId - User ID for organization
   * @param folder - Folder prefix (default: 'Collection')
   * @returns string - Unique S3 key
   */
  generateUniqueKey(fileName: string, userId: string, folder: string = 'Collection'): string {
    const timestamp = Date.now()
    const randomString = Math.random().toString(36).substring(2, 15)
    const extension = fileName.split('.').pop()
    return `${folder}/${userId}/${timestamp}-${randomString}.${extension}`
  }

  /**
   * Validate file type for image uploads
   * @param contentType - MIME type
   * @returns boolean
   */
  isValidImageType(contentType: string): boolean {
    const allowedTypes = [
      'image/jpeg',
      'image/jpg', 
      'image/png',
      'image/gif',
      'image/webp'
    ]
    return allowedTypes.includes(contentType.toLowerCase())
  }

  /**
   * Validate file size (max 5MB)
   * @param fileSize - File size in bytes
   * @returns boolean
   */
  isValidFileSize(fileSize: number): boolean {
    const maxSize = 5 * 1024 * 1024 // 5MB
    return fileSize <= maxSize
  }

  /**
   * Upload a file buffer directly to S3
   * @param key - The S3 object key (file path)
   * @param buffer - File buffer to upload
   * @param contentType - The MIME type of the file
   * @returns Promise<string> - Public S3 URL
   */
  async uploadFile(key: string, buffer: Buffer, contentType: string): Promise<string> {
    if (!env.AWS_S3_BUCKET) {
      throw new Error('AWS S3 bucket not configured')
    }

    const command = new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })

    await this.client.send(command)

    // Return the public S3 URL
    return `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`
  }

  /**
   * Get public URL for an S3 object
   * @param key - The S3 object key
   * @returns string - Public S3 URL
   */
  getPublicUrl(key: string): string {
    if (!env.AWS_S3_BUCKET) {
      throw new Error('AWS S3 bucket not configured')
    }
    return `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`
  }
}

export const s3Service = S3Service.getInstance()
