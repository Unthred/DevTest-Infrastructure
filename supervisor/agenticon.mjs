// Issue #1311: the pure check of an agent icon file's text. An icon is a plain one colour SVG the homeowner places on Tower; the screen uses it
// as a mask. This decides only whether the text is safe to hand to a browser, and says why not. It reads nothing and holds no state.
export const MAX_ICON_BYTES = 20000;

const TAG = /<\/?([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const PROLOGUE = /^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*>)*/i;
const ON_ATTRIBUTE = /(?:^|[\s"'/])on[\w:-]*\s*=/i;
const HREF = /(?:^|[\s"'/])(?:[\w-]+:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const URL_CALL = /url\(\s*(["']?)\s*([^)]*)\)/gi;
const STYLE_BLOCK = /<(?:[\w.-]+:)?style\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?style\s*>/gi;
// The XML parser decodes a character reference before SVG or CSS reads the text, so one could spell href, url( or @import past every text test.
const CHARACTER_REFERENCE = /&#/;

// A processing instruction (xml-stylesheet) or a DOCTYPE external identifier pulls in outside text without any element tag, so only the leading xml
// declaration is allowed and a DOCTYPE may not carry SYSTEM or PUBLIC.
const XML_DECLARATION = /^\s*<\?xml\s[^>]*\?>/;
const EXTERNAL_DOCTYPE = /<!DOCTYPE[^>]*\b(?:SYSTEM|PUBLIC)\b/i;
const hasForbiddenInstruction = text => text.replace(XML_DECLARATION, '').includes('<?');

const ANIMATION = new Set(['set', 'animate']);
const ANIMATED_REFERENCE = /(?:^|[\s"'/])attributeName\s*=\s*["']?\s*(?:[\w-]+:)?(?:href|on[\w-]*)\b/i;
const STYLE_ATTRIBUTE = /(?:^|[\s"'/])style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
// A backslash in CSS can spell url( or @import another way, so it is refused rather than decoded.
const unsafeStyle = css => /@import/i.test(css) || /url\s*\(/i.test(css) || css.includes('\\');
const unsafeStyleAttribute = attrs => [...attrs.matchAll(STYLE_ATTRIBUTE)].some(m => /@import/i.test(m[1] ?? m[2]) || (m[1] ?? m[2]).includes('\\'));
const localName = tag => tag.slice(tag.lastIndexOf(':') + 1).toLowerCase();
const nonFragmentHref = attrs => [...attrs.matchAll(HREF)].some(m => !(m[1] ?? m[2] ?? m[3] ?? '').trim().startsWith('#'));
const nonFragmentUrl = text => [...text.matchAll(URL_CALL)].some(m => !m[2].trim().startsWith('#'));

// Returns { ok: true } or { ok: false, reason }.
export function checkIcon(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'the file is empty' };
  if (Buffer.byteLength(text, 'utf8') > MAX_ICON_BYTES) return { ok: false, reason: `the file is larger than ${MAX_ICON_BYTES} bytes` };
  if (/<!ENTITY/i.test(text)) return { ok: false, reason: 'the file declares an entity' };
  if (CHARACTER_REFERENCE.test(text)) return { ok: false, reason: 'the file has a character reference' };
  if (hasForbiddenInstruction(text)) return { ok: false, reason: 'the file has a processing instruction other than the xml declaration' };
  if (EXTERNAL_DOCTYPE.test(text)) return { ok: false, reason: 'the DOCTYPE names an external identifier' };
  const rest = text.slice(text.match(PROLOGUE)[0].length);
  if (!/^<svg(?=[\s>/])/i.test(rest)) return { ok: false, reason: 'the root element is not svg' };
  const styles = [...text.matchAll(STYLE_BLOCK)];
  if (styles.some(m => unsafeStyle(m[1]))) return { ok: false, reason: 'a style element has an import or a url' };
  for (const [, tag, attrs] of text.matchAll(TAG)) {
    const lower = localName(tag);
    if (lower === 'script') return { ok: false, reason: 'the file has a script element' };
    if (lower === 'foreignobject') return { ok: false, reason: 'the file has a foreignObject element' };
    if (ANIMATION.has(lower) && ANIMATED_REFERENCE.test(attrs)) return { ok: false, reason: 'an animation changes a reference or an event attribute' };
    if (unsafeStyleAttribute(attrs)) return { ok: false, reason: 'a style attribute has an import or an escape' };
    if (ON_ATTRIBUTE.test(attrs)) return { ok: false, reason: 'an attribute name begins with on' };
    if (nonFragmentHref(attrs)) return { ok: false, reason: 'a reference points outside the file' };
    if (nonFragmentUrl(attrs)) return { ok: false, reason: 'a url points outside the file' };
  }
  return { ok: true };
}
