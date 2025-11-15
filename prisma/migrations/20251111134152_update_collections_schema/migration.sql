/*
  Warnings:

  - The primary key for the `Collection` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `description` on the `Collection` table. All the data in the column will be lost.
  - You are about to drop the column `images` on the `Collection` table. All the data in the column will be lost.
  - You are about to drop the column `title` on the `Collection` table. All the data in the column will be lost.
  - The `id` column on the `Collection` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[listingId]` on the table `Collection` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `data` to the `Collection` table without a default value. This is not possible if the table is not empty.
  - Added the required column `listingId` to the `Collection` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Collection" DROP CONSTRAINT "Collection_pkey",
DROP COLUMN "description",
DROP COLUMN "images",
DROP COLUMN "title",
ADD COLUMN     "data" JSONB NOT NULL,
ADD COLUMN     "listingId" TEXT NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "Collection_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE UNIQUE INDEX "Collection_listingId_key" ON "Collection"("listingId");
