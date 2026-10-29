// app/lib/app-store-rank.config.js
// What the owner dashboard's "App Store rank" card tracks for this app. These
// are only the starting list: once the dashboard has saved targets, the owner
// edits them there (lib/app-store-rank.server.js).
export const RANK = {
  handle: "zs-storesync",
  keywords: [
    "store migration", "migration", "store to store", "clone store", "duplicate store",
    "copy products", "sync products", "multi store sync", "inventory sync", "import export",
    "product import", "export products", "bulk import", "csv import", "transfer products",
    "data migration", "backup", "zs store sync",
  ],
  competitors: ["excel-export-import", "litextension-shopify-migration-app", "cart2cart-shopify-migration-module"],
};
