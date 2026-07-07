// composer/sanitize.ts — the paste XSS boundary (§14 top risk: this editor holds
// OTHER users' content). A rich editor's most dangerous surface is pasted HTML:
// `<img onerror>`, `<script>`, `javascript:` hrefs, event handlers. We NEVER trust
// pasted HTML — we strip it to its plain text content before ProseMirror parses
// it, so a pasted payload can only ever become INERT TEXT, never live markup and
// never an executing handler. The message we send is markdown SOURCE text (§5.4),
// not HTML, so there is no rich-paste feature to preserve here — plain text is the
// correct, safe fidelity. `DOMParser` (text/html) is inert by spec: it does not
// execute scripts, run event handlers, or fetch resources (no image loads).

/**
 * Reduce pasted HTML to inert plain text. `<script>`/`<style>` bodies are dropped
 * entirely; every other tag collapses to its text content. Returns `''` for
 * markup with no text (e.g. a bare `<img>`), which inserts nothing.
 */
export function sanitizePastedHtml(html: string): string {
  // No DOMParser (non-browser context) → strip tags with a conservative regex so
  // the function is still safe if ever called outside jsdom/a browser.
  if (typeof DOMParser === 'undefined') {
    return html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]*>/g, '')
      .trim()
  }
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script,style,template,noscript').forEach((el) => el.remove())
  return (doc.body.textContent ?? '').trim()
}
