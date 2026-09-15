import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

/**
 * "Have a referral code?" card for the Zilancer Affiliate Network.
 *
 * Self-contained: loads and saves through /app/referral-code and uses inline
 * styles that follow Shopify admin conventions, so it drops into any page.
 * Renders nothing when the integration is switched off.
 */
const styles = {
  card: {
    background: "#ffffff",
    border: "1px solid #e3e3e3",
    borderRadius: 12,
    padding: "16px 18px",
    margin: "20px 0",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'San Francisco', 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
    color: "#303030",
  },
  title: { fontSize: 14, fontWeight: 650, margin: 0 },
  hint: { fontSize: 13, color: "#616161", margin: "4px 0 12px" },
  row: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  input: {
    flex: "1 1 180px",
    maxWidth: 260,
    height: 32,
    padding: "0 10px",
    fontSize: 13,
    border: "1px solid #8a8a8a",
    borderRadius: 8,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    outlineColor: "#005bd3",
  },
  button: {
    height: 32,
    padding: "0 14px",
    fontSize: 13,
    fontWeight: 600,
    color: "#ffffff",
    background: "#303030",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  },
  error: { fontSize: 13, color: "#8e1f0b", margin: "8px 0 0" },
  applied: { fontSize: 13, color: "#0c5132", margin: 0 },
  code: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontWeight: 600 },
};

export default function AffiliateReferralCard() {
  const state = useFetcher();
  const submit = useFetcher();
  const [code, setCode] = useState("");

  useEffect(() => {
    if (state.state === "idle" && !state.data) state.load("/app/referral-code");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enabled = state.data?.enabled;
  const appliedCode = submit.data?.ok ? submit.data.code : state.data?.code;
  const busy = submit.state !== "idle";

  if (!enabled) return null;

  if (appliedCode) {
    return (
      <div style={styles.card}>
        <p style={styles.applied}>
          Referral code <span style={styles.code}>{appliedCode}</span> is applied to your store. Thanks for letting us
          know who sent you.
        </p>
      </div>
    );
  }

  return (
    <div style={styles.card}>
      <p style={styles.title}>Have a referral code?</p>
      <p style={styles.hint}>If someone recommended this app to you, enter their code so they get credit.</p>
      <submit.Form method="post" action="/app/referral-code" style={styles.row}>
        <input
          name="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="e.g. AFF123"
          aria-label="Referral code"
          autoComplete="off"
          maxLength={32}
          style={styles.input}
        />
        <button type="submit" disabled={busy || code.trim().length < 3} style={{ ...styles.button, opacity: busy || code.trim().length < 3 ? 0.55 : 1 }}>
          {busy ? "Applying…" : "Apply"}
        </button>
      </submit.Form>
      {submit.data && !submit.data.ok && (
        <p role="alert" style={styles.error}>
          {submit.data.error}
        </p>
      )}
    </div>
  );
}
