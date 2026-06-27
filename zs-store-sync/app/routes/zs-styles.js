// ─────────────────────────────────────────────────────────────────────────────
//  ZS StoreSync — Brand design tokens
//  Palette:  #A98B76 (clay)   #BFA28C (camel)   #F3E4C9 (cream)   #BABF94 (sage)
//  These CSS custom properties are shared across every page of the app.
// ─────────────────────────────────────────────────────────────────────────────
export const brandStyles = `
  .zs-root {
    /* ── Core palette ── */
    --zs-clay:        #A98B76;   /* primary warm brown        */
    --zs-clay-deep:   #8C6E58;   /* darker clay for hovers     */
    --zs-camel:       #BFA28C;   /* soft camel                 */
    --zs-cream:       #F3E4C9;   /* light cream                */
    --zs-cream-soft:  #FAF3E6;   /* even lighter cream wash    */
    --zs-sage:        #BABF94;   /* muted sage green           */
    --zs-sage-deep:   #8A9163;   /* deeper sage for text       */

    /* ── Semantic roles (mapped from palette) ── */
    --zs-dark:        #3A3128;   /* near-black warm espresso   */
    --zs-dark-2:      #4A4034;   /* secondary dark             */
    --zs-bg:          #FBF7EF;   /* page background            */
    --zs-white:       #FFFFFF;   /* cards / panels             */
    --zs-border:      #ECE3D4;   /* hairline borders           */
    --zs-muted:       #9A8E7E;   /* muted body text            */

    /* ── Soft accent fills (icon tiles etc.) ── */
    --zs-clay-soft:   #F1E7DD;
    --zs-camel-soft:  #F4EADE;
    --zs-cream-tint:  #FBF1DD;
    --zs-sage-soft:   #EDF0DD;

    /* gradient used on accents / progress bars */
    --zs-grad:        linear-gradient(135deg, var(--zs-clay), var(--zs-sage));
    --zs-grad-warm:   linear-gradient(135deg, var(--zs-clay), var(--zs-camel));
  }

  /* page background lives on the body wrapper */
  .zs-section-wrap { background: var(--zs-bg); }
`;
