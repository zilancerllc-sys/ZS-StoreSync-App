import { authenticate } from "../shopify.server";
import { applyReferralCode, getAffiliateState, isAffiliateEnabled } from "../lib/affiliate.server";

// Resource route behind <AffiliateReferralCard />: GET returns the saved code,
// POST applies a new one. No UI of its own.

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  if (!isAffiliateEnabled()) return { enabled: false, code: null };

  try {
    const state = await getAffiliateState(admin);
    return { enabled: true, code: state.referralCode };
  } catch (error) {
    console.error("[affiliate] loading referral code failed:", error?.message);
    return { enabled: false, code: null };
  }
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  return applyReferralCode({ admin, shop: session.shop, code: form.get("code") });
};
