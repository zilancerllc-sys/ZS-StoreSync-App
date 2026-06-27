-- AlterTable
ALTER TABLE "StoreConnection" ADD COLUMN     "codeVerified" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ShopSecret" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "connectionCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSecret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSecret_shop_key" ON "ShopSecret"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ShopSecret_connectionCode_key" ON "ShopSecret"("connectionCode");

-- CreateIndex
CREATE INDEX "ShopSecret_connectionCode_idx" ON "ShopSecret"("connectionCode");
