/**
 * Body-formatting helpers shared by views that render AMQP message bodies
 * (Subscriber, Browser, History). Keeps JSON pretty-printing, XML
 * pretty-printing, hex-dump and content-type detection consistent across
 * panes — previously these lived inline in each view, with subtle
 * differences (e.g. JSON detection but no XML).
 */

export function tryPrettyJson(s: string): string | null {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return null; }
}

export function tryPrettyXml(raw: string): string | null {
  try {
    const doc = new DOMParser().parseFromString(raw.trim(), "application/xml");
    if (doc.querySelector("parsererror")) return null;
    const serial = new XMLSerializer().serializeToString(doc);
    let depth = 0;
    return serial
      .replace(/>\s*</g, ">\n<")
      .split("\n")
      .map(line => {
        const t = line.trim();
        if (!t) return "";
        if (t.startsWith("</")) depth = Math.max(0, depth - 1);
        const out = "  ".repeat(depth) + t;
        if (t.startsWith("<") && !t.startsWith("</") && !t.startsWith("<?") && !t.endsWith("/>") && !t.includes("</")) depth++;
        return out;
      })
      .filter(Boolean)
      .join("\n");
  } catch { return null; }
}

/**
 * Classic hex+ASCII dump: 16 bytes per row, offset prefix, printable ASCII on
 * the right column. Caps at maxBytes to keep the preview pane responsive on
 * giant payloads — full content is still copyable via Body Copy.
 */
export function hexDump(text: string, maxBytes = 4096): string {
  const bytes = new TextEncoder().encode(text);
  const slice = bytes.subarray(0, maxBytes);
  const lines: string[] = [];
  for (let off = 0; off < slice.length; off += 16) {
    const chunk = slice.subarray(off, off + 16);
    const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(chunk).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : ".").join("");
    const offset = off.toString(16).padStart(8, "0");
    lines.push(`${offset}  ${hex.padEnd(48, " ")}  ${ascii}`);
  }
  if (bytes.length > maxBytes) {
    lines.push("");
    lines.push(`… ${bytes.length - maxBytes} more byte${bytes.length - maxBytes !== 1 ? "s" : ""} truncated`);
  }
  return lines.join("\n");
}

/**
 * Detect the body's structured format from `content_type` + leading character
 * heuristic. Used to pick the right pretty-formatter in AUTO body view mode.
 */
export function detectFormat(opts: { contentType?: string | null; bodyText?: string | null }): "json" | "xml" | "text" {
  const ct = (opts.contentType ?? "").toLowerCase();
  const t = (opts.bodyText ?? "").trimStart();
  if (ct.includes("json") || t.startsWith("{") || t.startsWith("[")) return "json";
  if (ct.includes("xml")  || t.startsWith("<")) return "xml";
  return "text";
}
