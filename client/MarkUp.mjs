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
    return this.marked.parse(body);
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
   * Basic sanitization to prevent XSS
   * marked handles most cases but we add extra protection
   */
  sanitize(text) {
    // Remove script tags
    text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    // Remove event handlers
    text = text.replace(/\bon\w+\s*=/gi, '');
    // Remove javascript: URLs
    text = text.replace(/javascript:/gi, '');
    return text;
  }
}

// Export for use as ES module or in browser
if (typeof window !== 'undefined') {
  window.MarkUp = MarkUp;
}