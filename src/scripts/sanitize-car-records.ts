import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

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

async function main() {
  console.log('Starting car records sanitization...')
  
  const carRecords = await prisma.carRecord.findMany({
    select: {
      id: true,
      weight: true,
      manufacture_date: true,
    }
  })

  console.log(`Found ${carRecords.length} car records to sanitize`)

  let updated = 0
  for (const record of carRecords) {
    const sanitizedWeight = sanitizeWeight(record.weight)
    const sanitizedManufactureDate = sanitizeManufactureDate(record.manufacture_date)
    
    // Only update if the values changed
    if (sanitizedWeight !== record.weight || sanitizedManufactureDate !== record.manufacture_date) {
      await prisma.carRecord.update({
        where: { id: record.id },
        data: {
          weight: sanitizedWeight,
          manufacture_date: sanitizedManufactureDate,
        }
      })
      updated++
      console.log(`Updated record ${record.id}: weight="${sanitizedWeight}", manufacture_date="${sanitizedManufactureDate}"`)
    }
  }

  console.log(`Sanitization complete! Updated ${updated} out of ${carRecords.length} records.`)
}

main()
  .catch((e) => {
    console.error('Error during sanitization:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

