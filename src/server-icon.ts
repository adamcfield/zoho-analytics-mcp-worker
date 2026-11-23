/**
 * The connector icon claude.ai shows next to this server (MCP `serverInfo.icons`).
 *
 * claude.ai only uses an icon that is an inline PNG or JPEG `data:` URI, 64–128 px and under
 * 10 KB; it never fetches an icon URL and drops SVG entries, and its favicon fallback looks up
 * `workers.dev`, which has none. So the logo travels inline, first in the list.
 * Docs: https://claude.com/docs/connectors/building/mcp-apps/design-guidelines
 */
export interface ServerIcon {
  src: string;
  mimeType: string;
  sizes?: string[];
}

/** Width × height of a PNG data URI (from the IHDR chunk), or undefined if it is not a PNG. */
export function pngSize(dataUri: string): { width: number; height: number } | undefined {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUri);
  if (!m) return undefined;
  const head = atob(m[1]!.slice(0, 44));
  const u32 = (o: number) => ((head.charCodeAt(o) << 24) | (head.charCodeAt(o + 1) << 16) | (head.charCodeAt(o + 2) << 8) | head.charCodeAt(o + 3)) >>> 0;
  return { width: u32(16), height: u32(20) };
}

/** True when claude.ai will accept this data URI as a connector icon. */
export function isClaudeIcon(dataUri: string): boolean {
  const size = pngSize(dataUri);
  if (!size) return false;
  const bytes = Math.floor(((dataUri.length - dataUri.indexOf(',') - 1) * 3) / 4);
  return size.width >= 64 && size.width <= 128 && size.height >= 64 && size.height <= 128 && bytes < 10_000;
}

/** `serverInfo.icons`: the inline PNG first (claude.ai), then any extra entries (e.g. an SVG URL for other clients). */
export function serverIcons(logo: string | undefined, extra: ServerIcon[] = []): ServerIcon[] | undefined {
  const icons: ServerIcon[] = [];
  if (logo && isClaudeIcon(logo)) {
    const { width, height } = pngSize(logo)!;
    icons.push({ src: logo, mimeType: 'image/png', sizes: [`${width}x${height}`] });
  }
  icons.push(...extra);
  return icons.length ? icons : undefined;
}
