# 03. Design system

The values below are the ones in `prototype/app.css`. A client on another platform maps the same token names to its own units.

## 1. Principles as rules

1. Calm when healthy: a healthy screen uses only the neutral tokens. Colour appears only where `attention` is not `none`, or for a running job.
2. Status is never colour alone: every status is a shape plus a word; colour reinforces.
3. Faults and homeowner waits have different shapes, colours, lists and counts. They never share a container.
4. Unknown has its own look (dashed, hatched, italic, "?"). It is never drawn as zero, as empty, or as OK.
5. An action answers where it was pressed. Nothing reloads; scroll, filters, view and focus stay.
6. Every number is a link to its list. Every list item opens the side panel.
7. One line for the app bar, always.

## 2. Tokens

### Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f4f5f7` | `#0e1115` | Page |
| `--surface` | `#ffffff` | `#161a20` | Cards, bars, panel |
| `--surface-2` | `#eceef2` | `#1e232b` | Table head, hover, board columns |
| `--text` | `#14181f` | `#e8ebef` | Text |
| `--muted` | `#556070` | `#9ba6b4` | Secondary text, neutral shapes |
| `--line` | `#d5dae1` | `#2a313b` | Borders |
| `--accent` | `#1a57b5` | `#78aeff` | Links, primary button, focus ring |
| `--ok` | `#17754a` | `#52c890` | Running, healthy meter |
| `--you` / `--you-bg` | `#5a3fd0` / `#efeaff` | `#b0a2ff` / `#262045` | Waits for the homeowner |
| `--fault` / `--fault-bg` | `#b3261e` / `#fdecea` | `#ff7b72` / `#3a1c1a` | Faults, stalled, refusals |
| `--warn` | `#8f5200` | `#f0b35a` | Allowance "high" level only |
| `--unknown` / `--unknown-bg` | `#5f6875` / `#eceef2` | `#9ba6b4` / `#1e232b` | Stale and unknown |

Text and status colours were chosen for at least 4.5:1 against their surface in both themes. That is a design target here; it is confirmed by the automated accessibility check in build item 8, not yet by a tool.

Violet for "you" is deliberate: it is far from red (fault), amber (allowance level) and green (running), so "waits for me" cannot be read as an error or a warning.

### Type

| Token | Value | Use |
|---|---|---|
| `--font` | system UI stack | Everything (no web font, no network) |
| `--mono` | system monospace stack | Ids, commands, raw lines |
| `--fs` | 14 px (13 px compact) | Body |
| `--fs-s` | 12 px | Meta, table heads, phone app bar |
| `--fs-l` | 18 px | Screen title, banner headline |
| Stat value | 26 px, weight 650, tabular figures | Headline numbers |

Numbers that are compared use tabular figures and right alignment.

### Space and size

| Token | Comfortable | Compact | Phone |
|---|---|---|---|
| `--gap` | 12 px | 8 px | 12 px |
| `--pad` | 16 px | 10 px | 12 px |
| `--row` (table and list row height) | 40 px | 30 px | 44 px always |
| `--bar` (app bar height) | 48 px | 48 px | 48 px |
| `--rail` (navigation width) | 168 px | 168 px | 0 (bottom tabs, 60 px) |
| `--radius` | 8 px | 8 px | 8 px |

Density changes row height, gaps and body size on a fine pointer only. On a coarse pointer (touch) every control is at least 44 px high whatever the density.

Breakpoint: 760 px. Below it: bottom tab bar, single column, side panel becomes a full screen sheet, secondary table columns are hidden (they remain in the panel), Inbox filters fold behind one button.

Themes: `data-theme="light|dark"` on the root, default from the system setting, remembered per viewer. Density: `data-density="comfortable|compact"`.

## 3. The one status language

The client maps a `condition` to a **tone** in one function (`toneOf` in `prototype/app.js`; the terminal client has the same mapping with glyphs):

```
attention = fault      -> fault
attention = homeowner  -> you
attention = unknown    -> unknown
otherwise              -> the state's group from meta.states
```

| Tone | Shape | Colour | Word shown | Terminal glyph | Examples |
|---|---|---|---|---|---|
| `active` | filled circle | `--ok` | the state | ● | running |
| `waiting` | ring | `--muted` | the state | ○ | idle, queued, approved |
| `held` | two bars (pause) | `--muted` | the state, then the reason | ‖ | held, parked, paused |
| `you` | diamond | `--you`, bold | the reason code in words | ◆ | waiting for approval, stuck at fix limit, decision proposal pending |
| `fault` | triangle | `--fault`, bold | the reason code in words | ▲ | stalled, blocked, failed, held with no reason recorded, malformed prerequisite line |
| `unknown` | dashed ring | `--unknown`, italic | "Unknown", "Stale", or "?" | ◌ | stale reading, expired window |
| `done` | small square, faint | `--muted` | the state | ■ | completed, done, clear |
| `off` | dash | `--muted` | the state | – | rejected, refused, stopped |

Rules:

- The same entity looks the same everywhere: a held PR has the pause shape in the Queue table, on the board tile, in the banner and in the panel.
- A state the client has never seen is drawn by its group. A new reason code is shown as its words (underscores to spaces).
- "No reason recorded" (`unrecorded`) is always the fault tone, whatever the state.
- The text after the status word is `reason_text` from the core, unchanged.

## 4. Components

### App bar
One line, 48 px, fixed. Left to right: product name (desktop only); state chip (shape, state word, duration on desktop); one chip per agent; slots and tick (desktop only); live indicator; theme and density (desktop; on phone they are in the last tab).

**Agent chip**: `dot name W% · S%`. W is the weekly window, S the 5 hour window. A stale reading underlines both figures with a dashed line and adds its age ("9h"); an unknown window shows "?" and no number. Tap or hover opens a popover: two allowance meters, reset times, reading age, roles, a link to Allowance. The accessible name spells it out ("codex: Paused, weekly 31%, 5 hour unknown, reading stale").

On phone the bar uses 12 px text and tighter chips. Measured in the prototype at 390 px with two agents: no clipping. With four or more agents the bar scrolls sideways; it never wraps to a second line.

### Status dot and status label
The shape alone (in dense lists, with the word as its title) or shape plus word. Never a bare coloured circle.

### Allowance meter
An 8 px bar with the figure and reset time under it. Levels `normal`, `high`, `near` change the fill (`--ok`, `--warn`, `--fault`) and the word. Unknown is a hatched bar with "Unknown: reason". A stale reading keeps the last fill and marks the figure "as last read".

### Card
Surface, 1 px border, 8 px radius. A 4 px left edge in `--you` or `--fault` (dashed `--unknown` for stale) is the only decoration, and only when the card's condition has that attention. Content order: status line, title, reason, controls. A card with no control and no link does not exist.

### Attention item (Overview lists)
Title; status word plus reason; "Your step" when it is a homeowner step; controls. A disabled control stays visible with the refusal text under it, so he can see what is not possible and why.

### Button and control
Primary (one per item, the cheapest sensible action), default, ghost, disabled with reason. Labels are verbs from a client side table keyed by command name ("Fix prerequisites", "Clear retry cap"); a command the client has no label for is shown by its verb. A command that needs a reason opens a small dialog with one text field; one that does not runs at once.

### Table with saved views
Sticky head, row height from `--row`, hover and focus rows, whole row opens the panel, controls inside a row do not. Above it: saved view chips, filter chips with counts (toggle, multi select within a group), search, view switch (cards, table, list), sort, group. A filter that arrived by link shows as a removable chip. Lists render 60 rows and offer "Show 60 more (N left)". Saved views are named sets of filters; built in ones cannot be deleted.

### Board
One column per stage from `queue.stages`, a count in each head, compact tiles with the status label. Scrolls sideways; a column never collapses to hide a stage with items.

### Compact list
One line per item: checkbox (when selectable), shape, title, kind, id. 30 to 44 px high. For scanning hundreds of items.

### Bulk bar
Appears at the bottom of a list when items are selected: count, the actions that apply to all selected, Clear. Reports "N of M applied" and names any refusal.

### Side panel
A 460 px drawer on desktop, a full screen sheet on phone. Header with title and Close (Escape closes). Sections in a fixed order: status and controls, facts, then the entity's own sections (reviews, requirements, jobs, timeline). The list behind keeps its scroll, filter and selection. Entities link to each other inside the panel.

### Filter chip
Pill, 32 px (44 px touch). Pressed state inverts. Count in tabular figures. Chips are buttons with `aria-pressed`.

### Banner
Full width, in the banner zone only. Three kinds:
- **Stalled** (`--fault-bg`): headline, the core's sentence, and on Overview one card per idle agent with reasons and controls; on other screens a single line and "See why".
- **Stale data** (`--unknown-bg`, dashed edge): "Data is stale. Last tick 22:05 (12m ago). Figures below may be out of date."
- **Behind**: "The live connection is behind. Showing the last data received; retrying."
A breaker halt uses the stalled style with its own headline.

### Timeline
A vertical line with dots; time (London), then the event sentence. Oldest first inside an item's panel.

### Id chip
Monospace, 8 characters, bordered. One tap copies; a toast confirms.

### Toast
Bottom centre, above the tab bar on phone. Says what happened in the command's words and the audit id. Reversible commands carry Undo for 12 seconds (the Inbox undo itself lasts 30 seconds; after the toast goes, Undo is on the Audit screen). A refusal is a red toast with the core's refusal text.

### Empty, error and stale states
- **Empty**: one sentence in muted text saying what is true ("Nothing waits for you.", "Nothing matches these filters."). No illustration.
- **Error**: when a read model cannot be fetched, the screen says so and shows nothing rather than old data: "Cannot read inbox from Foreman (reason)."
- **Stale**: the banner, plus the marker on each affected figure.
- **Loading**: the word "Loading" in the content area; the app bar renders as soon as its own model arrives.

## 5. Real time without flicker

- The client opens one event stream. An event names the models that changed; the client refetches only those, 200 ms after the last event, and re-renders.
- After a command the client updates the affected rows from the command result at once, then the stream confirms.
- The prototype re-renders a screen from state and restores focus, caret and scroll. The production client should key rows by entity key and replace only changed rows, so an open row or a text selection inside a row survives too.
- The live indicator has four states: Connecting, Live, Reconnecting, Behind. "Behind" (no heartbeat for 35 seconds) also raises the banner.
- Motion: none beyond a 150 ms switch transition; removed under reduced motion.

## 6. Accessibility and input

- Every control is a real button or link with a visible focus ring (2 px `--accent`). A skip link jumps to the content.
- Keyboard: Tab order follows reading order; Enter opens a focused row; Escape closes the panel and dialog.
- The banner zone and toasts are polite live regions.
- Status words are text; shapes are hidden from assistive technology.
- Touch targets are at least 44 px on touch devices; measured 44 px minimum for buttons at 390 px in the prototype.

## 7. Formatting (client side, by contract)

| Value | Shown as |
|---|---|
| Timestamps | Europe/London, "12 Nov, 22:04"; time only when the day is obvious |
| Durations | "3h 23m", "12m", "45s", "2d 4h" |
| Fractions | whole percent in bars and chips ("14%"); one decimal for rates ("21.7%") |
| Tokens | "86.0M", "912k", exact with separators in the panel |
| Pence | pounds with two decimals ("£193.50"); "usage equivalent" or "billed" beside totals |
| Unknown | the word "unknown" or "?", never 0 or a dash |
| Ids | first 8 characters, monospace, copy on tap |
