import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
  DeliveryMethod,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { BillingInterval } from "@shopify/shopify-app-react-router/server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  webhooks: {
    APP_SUBSCRIPTIONS_UPDATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/app-subscriptions-update",
    },
  },
  // ── Billing: Starter / Growth / Pro, each monthly + annual ──
  billing: {
    starter: {
      lineItems: [
        {
          amount: 12.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
          // ⬇ এই দুটো field বাধ্যতামূলক
          name: "Starter",
          trialDays: 0,
        },
      ],
    },
    starter_annual: {
      lineItems: [
        {
          amount: 139.99,
          currencyCode: "USD",
          interval: BillingInterval.Annual,
          name: "Starter Annual",
          trialDays: 0,
        },
      ],
    },
    growth: {
      lineItems: [
        {
          amount: 24.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
          name: "Growth",
          trialDays: 0,
        },
      ],
    },
    growth_annual: {
      lineItems: [
        {
          amount: 248.99,
          currencyCode: "USD",
          interval: BillingInterval.Annual,
          name: "Growth Annual",
          trialDays: 0,
        },
      ],
    },
    pro: {
      lineItems: [
        {
          amount: 39.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
          name: "Pro",
          trialDays: 0,
        },
      ],
    },
    pro_annual: {
      lineItems: [
        {
          amount: 459.99,
          currencyCode: "USD",
          interval: BillingInterval.Annual,
          name: "Pro Annual",
          trialDays: 0,
        },
      ],
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
