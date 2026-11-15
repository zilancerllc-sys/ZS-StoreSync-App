// Copy text from inside the embedded admin iframe.
//
// navigator.clipboard can be refused in an iframe (permissions policy, older
// browsers), and the copy buttons used to say "Copied" either way, so a
// merchant pasted whatever was on their clipboard before. This tries the
// Clipboard API, falls back to a hidden textarea + execCommand, and returns
// whether either worked so the button can tell the truth.
export async function copyText(text) {
  const value = String(text ?? "");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to the textarea route */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}
