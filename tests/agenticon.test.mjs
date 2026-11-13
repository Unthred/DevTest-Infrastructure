// Issue #1311: the pure check of an agent icon file. Fixtures are made up shapes, never a provider's logo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkIcon, MAX_ICON_BYTES } from '../supervisor/agenticon.mjs';

const STAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
  + '<path d="M12 2l3 7h7l-5.500 4.500 2 7.500-6.500-4.500-6.500 4.500 2-7.500L2 9h7z"/></svg>';
const HEXAGON = '<?xml version="1.0"?>\n<!-- a hexagon -->\n'
  + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="12,2 21,7 21,17 12,22 3,17 3,7"/></svg>';
const withBody = body => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${body}</svg>`;

test('a star and a hexagon are accepted, with or without an xml prologue', () => {
  assert.deepEqual(checkIcon(STAR), { ok: true });
  assert.deepEqual(checkIcon(HEXAGON), { ok: true });
});

test('a reference to a fragment inside the file is accepted', () => {
  assert.equal(checkIcon(withBody('<defs><path id="p" d="M0 0h4v4z"/></defs><use href="#p"/><use xlink:href="#p"/><path fill="url(#p)" d="M0 0"/>')).ok, true);
});

test('size boundary: exactly 20,000 bytes is accepted and one byte more is refused', () => {
  const pad = n => `<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(n)}--></svg>`;
  const base = pad(0).length;
  const exact = pad(MAX_ICON_BYTES - base);
  assert.equal(Buffer.byteLength(exact), MAX_ICON_BYTES);
  assert.equal(checkIcon(exact).ok, true);
  const over = checkIcon(pad(MAX_ICON_BYTES - base + 1));
  assert.equal(over.ok, false);
  assert.match(over.reason, /larger than 20000/);
});

test('each listed unsafe kind is refused with its own reason', () => {
  const cases = [
    ['a script element', withBody('<script>alert(1)</script>'), /script/],
    ['a script element in capitals', withBody('<SCRIPT>1</SCRIPT>'), /script/],
    ['an onload attribute', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M0 0"/></svg>', /begins with on/],
    ['an onclick attribute in single quotes', withBody("<path onclick='x()' d='M0 0'/>"), /begins with on/],
    ['a foreignObject', withBody('<foreignObject><div/></foreignObject>'), /foreignObject/],
    ['an image pointing at another host', withBody('<image href="https://example.invalid/x.png"/>'), /outside the file/],
    ['an xlink reference to another host', withBody('<use xlink:href="http://example.invalid/a.svg#p"/>'), /outside the file/],
    ['a javascript link', withBody('<a href="javascript:alert(1)"><path d="M0 0"/></a>'), /outside the file/],
    ['a data link', withBody('<image href="data:image/png;base64,AAAA"/>'), /outside the file/],
    ['a url in a presentation attribute', withBody('<path fill="url(https://example.invalid/p)" d="M0 0"/>'), /url points outside/],
    ['a style import', withBody('<style>@import "https://example.invalid/a.css";</style>'), /style element/],
    ['a style url', withBody('<style>path{fill:url(#p)}</style>'), /style element/],
    ['a prefixed script element', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>', /script/],
    ['a prefixed foreignObject', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:foreignObject/></svg>', /foreignObject/],
    ['a set that writes an href', withBody('<a><set attributeName="href" to="javascript:alert(1)"/></a>'), /animation/],
    ['an animate that writes an xlink href', withBody('<use href="#a"><animate attributeName="xlink:href" values="http://e/x.svg#a"/></use>'), /animation/],
    ['a css escape spelling url in a style element', withBody('<style>path{fill:\\75rl(http://e/x)}</style>'), /style element/],
    ['an import in a style attribute', withBody('<path style="@import \'http://e\'" d="M0 0"/>'), /style attribute/],
    ['a character reference spelling href', withBody('<a><set attributeName="&#104;ref" to="javascript:alert(1)"/></a>'), /character reference/],
    ['a hex character reference spelling href', withBody('<use href="#a"><animate attributeName="&#x68;ref" values="http://e/x.svg#a"/></use>'), /character reference/],
    ['a character reference spelling a parenthesis after url', withBody('<style>path{fill:url&#40;http://e/x)}</style>'), /character reference/],
    ['a character reference spelling import', withBody('<style>@im&#112;ort "http://e/x.css";</style>'), /character reference/],
    ['a character reference in a style attribute', withBody('<path style="fill:url&#40;http://e/x)" d="M0 0"/>'), /character reference/],
    ['a prefixed style element with a url', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:style>path{fill:url(http://e/x)}</s:style></svg>', /style element/],
    ['an entity declaration', '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>', /entity/],
  ];
  for (const [label, text, reason] of cases) {
    const verdict = checkIcon(text);
    assert.equal(verdict.ok, false, label);
    assert.match(verdict.reason, reason, label);
  }
});

test('a file that is not svg, an empty file, whitespace and a non-string are refused', () => {
  assert.match(checkIcon('<html><body/></html>').reason, /root element/);
  assert.match(checkIcon('just words').reason, /root element/);
  assert.match(checkIcon('<svgfoo/>').reason, /root element/);
  assert.match(checkIcon('<path d="M0 0"/><svg/>').reason, /root element/);
  for (const bad of ['', '  \n', null, undefined, 5]) assert.match(checkIcon(bad).reason, /empty/);
});

test('words that only look like an on attribute or a script are not refused', () => {
  assert.equal(checkIcon(withBody('<title>once on a script</title><path id="icon" d="M0 0"/>')).ok, true);
});
