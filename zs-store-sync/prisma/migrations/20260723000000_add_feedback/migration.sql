-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "message" TEXT,
    "emailed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Feedback_shop_idx" ON "Feedback"("shop");

-- CreateIndex
CREATE INDEX "Feedback_shop_createdAt_idx" ON "Feedback"("shop", "createdAt");
