// Dictionaries live on the server; the layout loader sends only the one the
// merchant needs. See index.js for how keys work.
import es from "./es.json";
import fr from "./fr.json";
import de from "./de.json";
import ptBR from "./pt-BR.json";
import it from "./it.json";
import ja from "./ja.json";

const DICTIONARIES = { es, fr, de, "pt-BR": ptBR, it, ja };

// "fr-CA" → "fr", "pt-PT" → "pt-BR" (closest we have), anything else → "en".
export function resolveLocale(raw) {
  const s = String(raw || "").trim();
  if (!s) return "en";
  if (DICTIONARIES[s]) return s;
  const base = s.split(/[-_]/)[0].toLowerCase();
  if (base === "pt") return "pt-BR";
  return DICTIONARIES[base] ? base : "en";
}

export function messagesFor(locale) {
  return DICTIONARIES[locale] || {};
}
