-- Lifecycle emails: welcome on install, a feedback nudge two days later, then
-- an occasional product update.
--
-- optedIn gates everything except the welcome mail. Shopify's Partner Program
-- Agreement 2.1.2 forbids emailing a merchant whose address came from Shopify
-- without consent, and CAN-SPAM requires a working unsubscribe in anything
-- promotional — unsubscribeToken is what makes that link work without a login.

CREATE TABLE "MerchantContact" (
    "id"               TEXT NOT NULL,
    "shop"             TEXT NOT NULL,
    "email"            TEXT,
    "optedIn"          BOOLEAN NOT NULL DEFAULT true,
    "unsubscribeToken" TEXT NOT NULL,
    "installedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "welcomeSentAt"    TIMESTAMP(3),
    "feedbackDueAt"    TIMESTAMP(3),
    "feedbackSentAt"   TIMESTAMP(3),
    "nextPromoAt"      TIMESTAMP(3),
    "lastPromoAt"      TIMESTAMP(3),
    "promoCount"       INTEGER NOT NULL DEFAULT 0,
    "unsubscribedAt"   TIMESTAMP(3),
    "uninstalledAt"    TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantContact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MerchantContact_shop_key" ON "MerchantContact" ("shop");
CREATE UNIQUE INDEX "MerchantContact_unsubscribeToken_key" ON "MerchantContact" ("unsubscribeToken");

-- The two due queries the ticker runs every minute.
CREATE INDEX "MerchantContact_optedIn_feedbackDueAt_idx" ON "MerchantContact" ("optedIn", "feedbackDueAt");
CREATE INDEX "MerchantContact_optedIn_nextPromoAt_idx" ON "MerchantContact" ("optedIn", "nextPromoAt");
