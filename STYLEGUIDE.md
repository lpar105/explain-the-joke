# Tight Five Frontend Styleguide

## Design Direction

The product should feel like a live comedy control room:

- editorial instead of corporate
- tactile instead of glossy
- sharp and confident instead of rounded and soft
- readable with good design principles

The baseline mood is "production console on warm paper."

## Core Principles

1. Use hard edges.
   Prefer square corners, visible borders, and offset shadows over soft cards.

2. Let structure do the styling.
   Strong layout, keylines, contrast, and typography should carry the design before decorative effects do.

3. Keep the palette restrained.
   Most surfaces stay neutral. Use red for active states and blue for primary actions.

4. Mix bold headlines with tiny utility text.
   Large uppercase labels create attitude. Mono microcopy adds precision.

5. Make interaction obvious.
   Hover, pressed, syncing, active, and historical states should all read instantly.

## Color System

These tokens are defined in [app/globals.css](/C:/Users/User/Documents/repos/tight-five/app/globals.css).

| Token | Value | Use |
| --- | --- | --- |
| `--tf-paper` | `#faf8f5` | Main app background |
| `--tf-paper-alt` | `#f0ede8` | Secondary panels, rails, muted fills |
| `--tf-ink` | `#1a1a1a` | Primary text, borders, keylines |
| `--tf-ink-soft` | `#444444` | Secondary body text |
| `--tf-ink-muted` | `#888888` | Labels, captions, timing text |
| `--tf-accent-red` | `#c41e3a` | Active states, live indicators, emphasis |
| `--tf-accent-red-hover` | `#d63a52` | Hover state for red actions |
| `--tf-accent-blue` | `#1a3a52` | Primary action buttons |
| `--tf-accent-blue-hover` | `#2a4a62` | Hover state for blue actions |
| `--tf-white` | `#ffffff` | Contrast surfaces and inverse text |

### Palette Rules

- Default page background: `--tf-paper`
- Default card background: `white`
- Neutral section background: `--tf-paper-alt`
- Default border color: `--tf-ink`
- Default highlight color: `--tf-accent-red`
- Do not introduce extra saturated colors unless they encode data

## Typography

The current app uses Inter/Geist in layout, but the visual treatment is what matters most.

### Roles

- Display/UI headings: bold or black, uppercase, tight tracking
- Labels and tabs: uppercase, compact, high contrast
- Utility text: mono, very small, muted
- Body/supporting copy: simple sans, compact line-height

### Recommended Scale

| Role | Suggested treatment |
| --- | --- |
| Page title | `text-2xl` to `text-4xl`, `font-black`, uppercase |
| Section title | `text-sm` to `text-base`, `font-black`, uppercase |
| Control label | `text-[9px]` to `text-xs`, `font-black`, uppercase |
| Row content | `text-[10px]` to `text-sm`, mono or sans depending on density |
| Meta text | `text-[8px]` to `text-[10px]`, `font-mono`, muted |

### Type Rules

- Use uppercase for controls, tabs, badges, and navigation labels.
- Use mono for timestamps, percentages, system states, and dense metadata.
- Avoid long paragraphs in this visual style. Keep copy clipped and purposeful.

## Spacing

This UI works best with compact spacing and strong alignment.

| Pattern | Recommendation |
| --- | --- |
| Page padding | `p-4` to `p-6` |
| Panel padding | `p-2` to `p-4` |
| Vertical stack gaps | `gap-3` to `gap-4` |
| Dense list gaps | `space-y-1` |
| Control height | `h-8` to `h-10` |

Use whitespace for rhythm, not softness. The layout should feel tight, not cramped.

## Shape, Border, Shadow

### Shape

- Corners should default to square
- Rounded corners should be rare, small, and purposeful

### Borders

- Primary panels: `2px solid var(--tf-ink)`
- Secondary separators: `1px solid var(--tf-ink)`
- Borders are part of the visual identity, not just containment

### Shadows

- Use offset block shadows instead of blur-heavy elevation
- Default panel shadow: `4px 4px 0 0 var(--tf-ink)`
- Active row shadow: `2px 2px 0 0 var(--tf-accent-red)`

## Components

### App Shell

- Warm paper background
- Strong horizontal rule under the nav
- Bold wordmark with a single accent color hit

### Buttons

- Square edges
- Heavy uppercase labels
- High-contrast fill or outlined keyline
- On hover: slight lift with offset shadow
- On active: slight downward movement

Primary action example:

```tsx
<Button className="bg-[#1a3a52] text-[#faf8f5] border-2 border-[#1a1a1a] font-black uppercase hover:bg-[#2a4a62]">
  Next Laugh
</Button>
```

### Panels

- White or warm-neutral fill
- Thick black outer border
- Optional offset shadow
- Header rows should feel like control strips

### Tabs

- Small, dense, bordered
- Active tab flips to dark fill with light text
- Inactive tabs remain white with subtle hover

### Lists and Rows

- Rows are compact and clickable
- Active rows use red border/shadow
- Historical rows may reduce opacity
- Hover states should shift background rather than animate heavily

### Data Visualization

- Keep charts and timelines simple, flat, and legible
- Use red intensity and black/red playhead accents
- Labels stay tiny and mono
- Avoid decorative gradients unless they convey meaning

## Motion

Motion should feel mechanical and responsive, not luxurious.

- Use very short transitions, around `100ms` to `150ms`
- Prefer transforms, opacity, and color changes
- Repeating animation is acceptable for live indicators only
- Avoid long easing curves and soft spring effects

Examples already in the UI:

- active row pulse
- live "laughing" badge waveform
- button press translation

## Interaction States

### Hover

- Slight background shift
- Optional offset shadow for buttons
- Keep the movement subtle and sharp

### Active/Selected

- Use `--tf-accent-red`
- Increase contrast through border and shadow, not glow

### Disabled/Loading

- Lower opacity
- Preserve layout and border shape
- Use tiny mono status text like `syncing...` or `connecting player...`

## Layout Patterns

### Recommended Screen Composition

- One dominant workspace area
- One secondary inspector, control panel, or list
- Clear header strip for mode switches and system status
- Dense scrollable side panels

This means layouts like:

- `2 / 1` split on desktop
- stacked single-column on mobile

## Tailwind Usage

Reusable Tight Five utilities have been added to [app/globals.css](/C:/Users/User/Documents/repos/tight-five/app/globals.css):

- `bg-tf-paper`
- `bg-tf-paper-alt`
- `text-tf-ink`
- `text-tf-ink-soft`
- `text-tf-ink-muted`
- `text-tf-red`
- `text-tf-paper`
- `border-tf`
- `border-tf-subtle`
- `shadow-tf-card`
- `shadow-tf-active`
- `tracking-tf-ui`
- `tracking-tf-tight`

Example panel:

```tsx
<section className="bg-white border-tf shadow-tf-card">
  <header className="bg-tf-paper-alt border-b-2 border-[#1a1a1a] px-3 py-2 flex items-center justify-between">
    <h2 className="text-xs font-black uppercase tracking-tf-ui text-tf-ink">Panel Title</h2>
    <span className="text-[9px] font-mono text-tf-ink-muted">live</span>
  </header>
  <div className="p-3 text-sm text-tf-ink-soft">
    Content
  </div>
</section>
```

## Do / Don't

### Do

- use black keylines generously
- use beige and white as the dominant surfaces
- use red sparingly for active emphasis
- keep components compact
- prefer bold typography over ornamental decoration
- focus language and copy around what is important to comedians

### Don't

- don't default to rounded-xl cards
- don't use soft gray-on-gray contrast
- don't introduce glassmorphism, heavy blur, or neon glow
- don't overspace layouts into a generic SaaS look
- don't mix too many accent colors into one screen
- share implementation details that relate more to developer flows and processes than comedian goals

## Implementation Notes

When building new screens, start from these defaults:

1. `bg-tf-paper` page background
2. `border-tf` panels
3. uppercase `font-black` labels
4. mono microcopy for status and metadata
5. `text-tf-red` only for live, active, or critical emphasis

If a new page feels too polished, rounded, or airy, it has probably drifted away from the `SetBreakdown` visual language.
