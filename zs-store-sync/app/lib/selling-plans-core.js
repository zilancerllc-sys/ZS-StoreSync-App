// Pure helpers for copying selling plan groups (subscriptions, pre-orders,
// try before you buy) from the source store's read shape into create inputs.
const lc = (s) => String(s || "").trim().toLowerCase();

const anchors = (list) =>
  (list || []).map((a) => {
    const o = { type: a.type, day: a.day };
    if (a.month != null) o.month = a.month;
    if (a.cutoffDay != null) o.cutoffDay = a.cutoffDay;
    return o;
  });

const pct = (v) => v?.percentage != null;

export function billingPolicyInput(p) {
  if (!p) return null;
  if (p.__typename === "SellingPlanRecurringBillingPolicy") {
    const r = { interval: p.interval, intervalCount: p.intervalCount, anchors: anchors(p.anchors) };
    if (p.minCycles != null) r.minCycles = p.minCycles;
    if (p.maxCycles != null) r.maxCycles = p.maxCycles;
    return { recurring: r };
  }
  if (p.__typename === "SellingPlanFixedBillingPolicy") {
    const v = p.checkoutCharge?.value || {};
    const f = {
      checkoutCharge: {
        type: p.checkoutCharge?.type,
        value: pct(v) ? { percentage: v.percentage } : { fixedValue: String(v.amount ?? 0) },
      },
      remainingBalanceChargeTrigger: p.remainingBalanceChargeTrigger,
    };
    if (p.remainingBalanceChargeExactTime) f.remainingBalanceChargeExactTime = p.remainingBalanceChargeExactTime;
    if (p.remainingBalanceChargeTimeAfterCheckout) f.remainingBalanceChargeTimeAfterCheckout = p.remainingBalanceChargeTimeAfterCheckout;
    return { fixed: f };
  }
  return null;
}

export function deliveryPolicyInput(p) {
  if (!p) return null;
  if (p.__typename === "SellingPlanRecurringDeliveryPolicy") {
    const r = {
      interval: p.interval,
      intervalCount: p.intervalCount,
      anchors: anchors(p.anchors),
      intent: p.intent,
      preAnchorBehavior: p.preAnchorBehavior,
    };
    if (p.cutoff != null) r.cutoff = p.cutoff;
    return { recurring: r };
  }
  if (p.__typename === "SellingPlanFixedDeliveryPolicy") {
    const f = {
      anchors: anchors(p.anchors),
      fulfillmentTrigger: p.fulfillmentTrigger,
      // read under aliases: the recurring policy's fields have other enum types
      intent: p.fixedIntent ?? p.intent,
      preAnchorBehavior: p.fixedPreAnchorBehavior ?? p.preAnchorBehavior,
    };
    if (p.cutoff != null) f.cutoff = p.cutoff;
    if (p.fulfillmentExactTime) f.fulfillmentExactTime = p.fulfillmentExactTime;
    return { fixed: f };
  }
  return null;
}

export function pricingPoliciesInput(list) {
  return (list || [])
    .map((p) => {
      const v = p.adjustmentValue || {};
      const adjustmentValue = pct(v) ? { percentage: v.percentage } : { fixedValue: String(v.amount ?? 0) };
      if (p.__typename === "SellingPlanRecurringPricingPolicy") {
        return { recurring: { adjustmentType: p.adjustmentType, adjustmentValue, afterCycle: p.afterCycle ?? 0 } };
      }
      if (p.__typename === "SellingPlanFixedPricingPolicy") {
        return { fixed: { adjustmentType: p.adjustmentType, adjustmentValue } };
      }
      return null;
    })
    .filter(Boolean);
}

export function sellingPlanInput(sp) {
  const input = { name: sp.name, options: sp.options || [] };
  if (sp.description) input.description = sp.description;
  if (sp.position != null) input.position = sp.position;
  if (sp.category) input.category = sp.category;
  const billing = billingPolicyInput(sp.billingPolicy);
  const delivery = deliveryPolicyInput(sp.deliveryPolicy);
  if (billing) input.billingPolicy = billing;
  if (delivery) input.deliveryPolicy = delivery;
  const pricing = pricingPoliciesInput(sp.pricingPolicies);
  if (pricing.length) input.pricingPolicies = pricing;
  if (sp.inventoryPolicy?.reserve) input.inventoryPolicy = { reserve: sp.inventoryPolicy.reserve };
  return input;
}

export function sellingPlanGroupInput(g) {
  const input = {
    name: g.name,
    merchantCode: g.merchantCode || g.name,
    options: g.options || [],
    sellingPlansToCreate: (g.sellingPlans?.nodes || []).map(sellingPlanInput),
  };
  if (g.description) input.description = g.description;
  if (g.position != null) input.position = g.position;
  return input;
}

// Re-runs: a group is the same when its merchant code and name match.
export function groupKey(g) {
  return `${lc(g?.merchantCode)}|${lc(g?.name)}`;
}

// Categories that need an app to charge customers after checkout.
export function needsBillingApp(g) {
  return (g?.sellingPlans?.nodes || []).some(
    (sp) =>
      sp.billingPolicy?.__typename === "SellingPlanRecurringBillingPolicy" ||
      (sp.billingPolicy?.__typename === "SellingPlanFixedBillingPolicy" &&
        sp.billingPolicy?.remainingBalanceChargeTrigger &&
        sp.billingPolicy.remainingBalanceChargeTrigger !== "NO_REMAINING_BALANCE"),
  );
}
