// app/lib/download.js
// Client-side helper for downloading a file from one of our own resource routes.
//
// A plain <a href="/app/foo.csv" download> does NOT work inside the embedded
// admin: the browser navigates on its own and never attaches the App Bridge
// session token, so authenticate.admin() bounces the request and the browser
// saves the auth bootstrap HTML as "foo.htm". App Bridge patches window.fetch
// to add the token for same-origin requests, so we fetch the file ourselves and
// hand the resulting blob to a temporary anchor instead.

function filenameFromDisposition(header, fallback) {
  if (!header) return fallback;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return match ? decodeURIComponent(match[1]) : fallback;
}

export async function downloadFile(url, fallbackName) {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(await res.text().catch(() => `Request failed (${res.status})`));
  }

  // An auth bounce comes back as 200 + HTML, so check the type before saving —
  // otherwise the user gets a .csv full of <script> tags.
  const type = res.headers.get("Content-Type") || "";
  if (type.includes("text/html")) {
    throw new Error("Session expired. Reload the page and try again.");
  }

  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get("Content-Disposition"), fallbackName);

  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}
