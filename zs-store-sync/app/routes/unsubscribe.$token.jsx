import { useLoaderData } from "react-router";
import { unsubscribeByToken } from "../lifecycle.server";

// Public on purpose: an unsubscribe link has to work from an email client with
// no Shopify session, on a phone, months later. The token is random and grants
// nothing except turning this store's non-essential email off.
//
// Unsubscribing happens in the loader rather than behind a confirm button. Mail
// clients that prefetch links would otherwise leave people clicking into a page
// that hasn't done anything, and CAN-SPAM wants the opt-out to be simple. The
// page tells them how to switch it back on.
export const loader = async ({ params }) => {
  const shop = await unsubscribeByToken(params.token);
  return { shop };
};

export default function Unsubscribe() {
  const { shop } = useLoaderData();

  return (
    <div
      style={{
        fontFamily: "-apple-system, Segoe UI, Roboto, Helvetica, sans-serif",
        background: "#faf7f1",
        color: "#3a3128",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        margin: 0,
      }}
    >
      <div
        style={{
          background: "#fff",
          border: "1px solid #ece5db",
          borderRadius: 16,
          padding: "34px 32px",
          maxWidth: 460,
          width: "100%",
          textAlign: "center",
        }}
      >
        {shop ? (
          <>
            <h1 style={{ fontSize: 21, margin: "0 0 10px" }}>
              You&apos;re unsubscribed
            </h1>
            <p style={{ fontSize: 14.5, lineHeight: 1.65, color: "#6b6259", margin: "0 0 14px" }}>
              <b>{shop}</b> won&apos;t get product updates or feedback requests
              from ZS StoreSync any more.
            </p>
            <p style={{ fontSize: 13.5, lineHeight: 1.65, color: "#8a7d70", margin: 0 }}>
              You&apos;ll still get email about things you switched on yourself,
              like the results of a scheduled sync. Changed your mind? Turn
              updates back on in ZS StoreSync → Settings.
            </p>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 21, margin: "0 0 10px" }}>
              This link has already been used
            </h1>
            <p style={{ fontSize: 14.5, lineHeight: 1.65, color: "#6b6259", margin: 0 }}>
              Either you&apos;ve unsubscribed already, or the link is no longer
              valid. You can manage email in ZS StoreSync → Settings.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
