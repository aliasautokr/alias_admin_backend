import sharp from 'sharp'

export interface OptimizeImageOptions {
  maxWidth?: number
  maxHeight?: number
  quality?: number
  format?: 'jpeg' | 'png' | 'webp'
}

export interface OptimizedImageResult {
  buffer: Buffer
  contentType: string
  originalSize: number
  optimizedSize: number
  width: number
  height: number
}

/**
 * Optimize an image buffer to reduce file size while maintaining quality
 * @param inputBuffer - Original image buffer
 * @param options - Optimization options
 * @returns Optimized image buffer with metadata
 */
export async function optimizeImage(
  inputBuffer: Buffer,
  options: OptimizeImageOptions = {}
): Promise<OptimizedImageResult> {
  const {
    maxWidth = 1920, // Max width 1920px (Full HD)
    maxHeight = 1920, // Max height 1920px
    quality = 85, // Quality 85% (good balance between quality and size)
    format = 'jpeg', // Default to JPEG for better compression
  } = options

  const originalSize = inputBuffer.length

  // Get image metadata
  const metadata = await sharp(inputBuffer).metadata()
  const originalWidth = metadata.width || 0
  const originalHeight = metadata.height || 0

  // Calculate new dimensions maintaining aspect ratio
  let targetWidth = originalWidth
  let targetHeight = originalHeight

  if (originalWidth > maxWidth || originalHeight > maxHeight) {
    const aspectRatio = originalWidth / originalHeight
    if (originalWidth > originalHeight) {
      targetWidth = Math.min(originalWidth, maxWidth)
      targetHeight = Math.round(targetWidth / aspectRatio)
    } else {
      targetHeight = Math.min(originalHeight, maxHeight)
      targetWidth = Math.round(targetHeight * aspectRatio)
    }
  }

  // Determine output format based on input
  let outputFormat: 'jpeg' | 'png' | 'webp' = format
  const inputFormat = metadata.format

  // Preserve transparency for PNG/GIF by keeping as PNG
  // Otherwise convert to JPEG for better compression
  if (inputFormat === 'png' || inputFormat === 'gif') {
    // Check if image has transparency
    const stats = await sharp(inputBuffer).stats()
    const hasAlpha = stats.channels.length > 3 && stats.channels[3]
    
    if (hasAlpha && hasAlpha.min !== undefined && hasAlpha.max !== undefined) {
      // Has transparency, use PNG or WebP
      outputFormat = format === 'webp' ? 'webp' : 'png'
    } else {
      // No transparency, convert to JPEG for better compression
      outputFormat = 'jpeg'
    }
  } else if (inputFormat === 'webp') {
    outputFormat = 'webp'
  }

  // Optimize image
  let pipeline = sharp(inputBuffer).resize(targetWidth, targetHeight, {
    fit: 'inside',
    withoutEnlargement: true,
  })

  // Apply format-specific optimizations
  switch (outputFormat) {
    case 'jpeg':
      pipeline = pipeline.jpeg({
        quality,
        progressive: true,
        mozjpeg: true, // Use mozjpeg for better compression
      })
      break
    case 'png':
      pipeline = pipeline.png({
        quality,
        compressionLevel: 9, // Max compression
        adaptiveFiltering: true,
      })
      break
    case 'webp':
      pipeline = pipeline.webp({
        quality,
        effort: 6, // Higher effort = better compression but slower
      })
      break
  }

  const optimizedBuffer = await pipeline.toBuffer()
  const optimizedSize = optimizedBuffer.length

  // Determine content type
  const contentType = outputFormat === 'jpeg' 
    ? 'image/jpeg' 
    : outputFormat === 'png' 
    ? 'image/png' 
    : 'image/webp'

  return {
    buffer: optimizedBuffer,
    contentType,
    originalSize,
    optimizedSize,
    width: targetWidth,
    height: targetHeight,
  }
}

/**
 * Get optimal format for an image based on its characteristics
 * @param inputBuffer - Image buffer
 * @returns Suggested format ('jpeg', 'png', or 'webp')
 */
export async function getOptimalFormat(inputBuffer: Buffer): Promise<'jpeg' | 'png' | 'webp'> {
  const metadata = await sharp(inputBuffer).metadata()
  
  // If PNG or GIF, check for transparency
  if (metadata.format === 'png' || metadata.format === 'gif') {
    try {
      const stats = await sharp(inputBuffer).stats()
      const hasAlpha = stats.channels.length > 3 && stats.channels[3]
      if (hasAlpha && hasAlpha.min !== undefined && hasAlpha.max !== undefined) {
        // Has transparency, prefer WebP if supported, else PNG
        return 'webp'
      }
    } catch (error) {
      // If we can't determine, default to PNG
      return 'png'
    }
  }
  
  // For most images, JPEG provides best compression
  // WebP is better but may have compatibility issues
  return 'jpeg'
}

