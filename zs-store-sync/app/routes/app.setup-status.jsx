import { authenticate } from "../shopify.server";
import { setupStatus } from "../lib/setup-status.server";

// Resource route: the setup bar re-checks through this when the merchant comes
// back to the tab, without re-running the layout loader (which would lose the
// admin language it only gets on the first load).
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  return { status: await setupStatus(session.shop).catch(() => null) };
};
