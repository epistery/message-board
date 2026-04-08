/**
 * MarkUp - Basic markdown renderer for message-board
 *
 * Simplified from wiki MarkUp - no WikiWords, mermaid, or frame extensions.
 * Just basic markdown: links, bold, italic, lists, code, etc.
 */

export default class MarkUp {
  constructor() {
    this.marked = null;
  }

  /**
   * Initialize the renderer
   * Must be called before render()
   */
  async init() {
    if (!this.marked) {
      const { marked } = await import('https://cdn.jsdelivr.net/npm/marked@12.0.0/lib/marked.esm.js');
      this.marked = marked;

      // Configure marked for safe output
      this.marked.setOptions({
        gfm: true,
        breaks: true,
        async: false
      });
    }
  }

  /**
   * Render markdown to HTML (synchronous after init)
   * @param {string} body - Markdown content
   * @returns {string} HTML content
   */
  render(body) {
    if (!this.marked) {
      console.warn('[MarkUp] Not initialized, returning escaped text');
      return this.escapeHtml(body);
    }

    // Sanitize dangerous HTML patterns before rendering
    body = this.sanitize(body);

    // Render markdown (synchronous)
    const html = this.marked.parse(body);

    // Balance tags. marked passes raw inline HTML through (gfm: true), so a
    // post containing pasted HTML with an unclosed <a> emits unclosed HTML.
    // When that string is concatenated into a larger innerHTML, the browser
    // parser lets the open tag wrap subsequent siblings — which has bitten
    // us by making the comment form a child of an unclosed anchor, causing
    // clicks to navigate. Run the output through the HTML parser inside an
    // isolated container so any unbalanced tags are auto-closed within scope.
    return this.balanceHtml(html);
  }

  /**
   * Round-trip HTML through the browser's parser so unclosed tags are
   * auto-closed within an isolated scope. The DOM parser is the same one
   * the page itself uses, so the output is guaranteed well-formed.
   */
  balanceHtml(html) {
    if (typeof document === 'undefined') return html;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.innerHTML;
  }

  /**
   * Escape HTML entities (fallback if not initialized)
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Basic sanitization to prevent XSS. Operates on the markdown source
   * before rendering. Only acts inside HTML-tag-shaped fragments so prose
   * containing words like "onset=" or the literal text "javascript:" in a
   * sentence is left alone.
   */
  sanitize(text) {
    // Strip <script>...</script> blocks anywhere.
    text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    // Within any HTML tag, remove on*= event-handler attributes and any
    // javascript: protocol values. The replace callback scopes the inner
    // regexes so they cannot match prose outside tags.
    text = text.replace(/<[^>]*>/g, (tag) => {
      tag = tag.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
      tag = tag.replace(/\b(href|src|xlink:href)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, '$1=""');
      return tag;
    });
    return text;
  }
}

// Export for use as ES module or in browser
if (typeof window !== 'undefined') {
  window.MarkUp = MarkUp;
}