/** astro.config.mjs — Jarvis docs site.
 *
 *  Why this lives in docs-site/ instead of at the repo root: keeping the
 *  docs as a separate npm root means the kiosk's bundle stays Astro-free
 *  (the kiosk has zero build step — it loads index.html directly via the
 *  static server) and lets the docs site be deployed independently to
 *  GitHub Pages / Vercel without dragging the bridge's runtime deps along.
 *
 *  Site URL is intentionally absent until the operator picks a host.
 *  GitHub Pages default would be https://w17ant.github.io/Jarvis/ —
 *  add `site:` and `base: '/Jarvis'` if that's the route the operator
 *  picks. Vercel / Cloudflare Pages don't need a base path.
 */
import { defineConfig } from "astro/config";

export default defineConfig({
  // Production canonical. Path-prefix deploy under aoneill.co.uk/arc/ so the
  // docs site sits alongside the existing client-demo subtrees in the
  // operator's Next.js portfolio (mirrors renovaelabs / tomthevacuumman).
  // "arc" is a neutral umbrella in case the product ever renames away from
  // Jarvis — survives a rebrand.
  //
  // To switch to a dedicated subdomain (arc.aoneill.co.uk):
  //   site: "https://arc.aoneill.co.uk"
  //   base: "/"     (omit base entirely)
  //
  // To switch to GitHub Pages default:
  //   site: "https://w17ant.github.io"
  //   base: "/Jarvis"
  site: "https://aoneill.co.uk",
  base: "/arc",
  trailingSlash: "always",   // matches the Next.js portfolio's trailingSlash:true
  // GFM tables, footnotes, autolinks — keep the prose rendering close to
  // what GitHub shows so authors can preview locally without surprises.
  markdown: {
    syntaxHighlight: "shiki",
    shikiConfig: {
      // Match the HUD's arc-reactor cyan-on-dark aesthetic.
      theme: "github-dark-default",
      wrap: true,
    },
  },
  // No integrations to start — keeps the dep surface minimal. Add @astrojs/sitemap,
  // @astrojs/mdx, or starlight only when there's a concrete need.
});
