// Issue #1317: the legend of the four job families: a colour swatch and the words, shown above the drawing on the board and, below 640 px
// where the board is not drawn, above the lists. The colours come from the stylesheet through the same family classes the balls use.
import { FAMILIES } from './boardball.mjs';
import { el } from './boardlists.mjs';

export const legend = () => el('ul', { class: 'board-legend', 'aria-label': 'Ball colours by job type' },
  ...FAMILIES.map(family => el('li', { class: 'legend-item' }, el('span', { class: `swatch family-${family.id}`, 'aria-hidden': 'true' }),
    ` ${family.label}`, el('span', { class: 'legend-types' }, ` (${family.words})`))));
