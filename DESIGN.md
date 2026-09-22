---
name: GZ Bonsai 27B
description: A calm, native-feeling macOS home for private local Bonsai models.
colors:
  forest-primary: "#2f6949"
  forest-action: "#377452"
  leaf-cream: "#f4f6ef"
  pine-ink: "#233129"
  body-ink: "#334038"
  muted-ink: "#59685f"
  quiet-ink: "#778079"
  workspace-mist: "#eef0eb"
  sidebar-mint: "#dceee2"
  main-paper: "#fbfbfa"
  raised-white: "#ffffff"
  hairline: "#dce0dc"
  divider: "#eceeeb"
  leaf-success: "#54a16b"
  amber-progress: "#d29c4e"
  clay-danger: "#bc6657"
  clay-stop: "#795048"
typography:
  headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", ui-sans-serif, sans-serif'
    fontSize: "21px"
    fontWeight: 650
    letterSpacing: "-0.02em"
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", ui-sans-serif, sans-serif'
    fontSize: "14px"
    fontWeight: 760
    letterSpacing: "-0.01em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", ui-sans-serif, sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", ui-sans-serif, sans-serif'
    fontSize: "10px"
    fontWeight: 650
    lineHeight: 1.35
rounded:
  compact: "7px"
  control: "9px"
  picker: "10px"
  panel: "13px"
  card: "14px"
  composer: "15px"
  shell: "18px"
  full: "999px"
spacing:
  xxs: "3px"
  xs: "4px"
  sm: "8px"
  control: "10px"
  md: "12px"
  lg: "14px"
  field: "15px"
  section: "18px"
  page: "24px"
components:
  button-primary:
    backgroundColor: "{colors.forest-primary}"
    textColor: "{colors.raised-white}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
  button-secondary:
    backgroundColor: "#edf5ef"
    textColor: "{colors.forest-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  nav-active:
    backgroundColor: "rgba(255, 255, 255, 0.76)"
    textColor: "#1e3d2b"
    rounded: "{rounded.control}"
    padding: "9px 10px"
  model-picker:
    backgroundColor: "{colors.raised-white}"
    textColor: "{colors.body-ink}"
    rounded: "{rounded.picker}"
    padding: "6px 9px"
  composer:
    backgroundColor: "{colors.raised-white}"
    textColor: "{colors.body-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.composer}"
    padding: "10px 11px 10px 15px"
    height: "68px"
  field:
    backgroundColor: "#fafbfa"
    textColor: "{colors.body-ink}"
    rounded: "{rounded.control}"
    padding: "10px 11px"
  settings-card:
    backgroundColor: "{colors.raised-white}"
    textColor: "{colors.body-ink}"
    rounded: "{rounded.card}"
    padding: "22px"
  leaf-mark:
    backgroundColor: "{colors.forest-primary}"
    textColor: "{colors.leaf-cream}"
    rounded: "{rounded.control}"
    padding: "5px"
    size: "30px"
---

# Design System: GZ Bonsai 27B

## Overview

**Creative North Star: "The Quiet Local Grove"**

GZ Bonsai 27B feels like a calm, well-made macOS utility: persistent navigation sits on a pale green plane while the main work happens on a spacious, warm paper canvas. The interface is restrained and information-led, with the product identity carried by the authored bonsai leaf, the green-and-cream palette, and careful native-feeling proportions rather than decoration.

The visual system is deliberately compact around controls and generous around the conversation. Fine borders, low ambient shadows, and small semantic status signals make technical state legible without turning the app into a dashboard. It may borrow the clarity of familiar local-model tools, but it must remain recognizably GZ Bonsai rather than imitating ChatGPT or Jan.

**Key Characteristics:**

- Persistent pale-green sidebar beside a warm, quiet working canvas.
- Original bonsai leaf mark and consistently authored outline icons.
- Compact 10–13px operational text with functional headings capped at 21px.
- Softly rounded controls, fine neutral-green borders, and restrained ambient depth.
- Generous conversation measure with the composer anchored to the bottom edge.

## Colors

The palette is a muted grove of forest green, pale mint, warm cream, and green-biased neutrals; semantic amber and clay appear only when runtime state requires them.

### Primary

- **Bonsai Forest** (`colors.forest-primary`): The signature action and identity color for the leaf mark, send action, and primary controls.
- **Action Leaf** (`colors.forest-action`): A slightly lighter green reserved for action text and quiet interactive emphasis.
- **Leaf Cream** (`colors.leaf-cream`): The warm stroke color inside the dark leaf mark.

### Secondary

- **Sidebar Mint** (`colors.sidebar-mint`): The persistent navigation plane that gives the app its recognizable silhouette.
- **Workspace Mist** (`colors.workspace-mist`): The outer shell field that separates the window composition from the desktop.

### Tertiary

- **Leaf Success** (`colors.leaf-success`): Ready and private-local status signals.
- **Amber Progress** (`colors.amber-progress`): Starting and stopping runtime states.
- **Clay Danger** (`colors.clay-danger`): Error indication.
- **Clay Stop** (`colors.clay-stop`): The deliberate destructive stop action.

### Neutral

- **Pine Ink** (`colors.pine-ink`): The strongest text and root foreground.
- **Body Ink** (`colors.body-ink`): Default copy, message text, and control labels.
- **Muted Ink** (`colors.muted-ink`): Secondary metadata that must remain comfortably readable.
- **Quiet Ink** (`colors.quiet-ink`): Descriptions and lower-priority explanatory copy.
- **Main Paper** (`colors.main-paper`): The conversation and content canvas.
- **Raised White** (`colors.raised-white`): Inputs, cards, active navigation, and compact elevated controls.
- **Hairline** (`colors.hairline`): Standard control and card border.
- **Divider** (`colors.divider`): Lighter separators within the main pane.

### Named Rules

**The Living Green Rule.** Green carries identity, readiness, and safe forward action; never flood the main canvas with it.

**The Semantic Restraint Rule.** Amber and clay belong to runtime state and destructive action only, never to decoration.

## Typography

**Display Font:** Apple system stack (`typography.headline`)
**Body Font:** Apple system stack (`typography.body`)
**Label/Mono Font:** Apple system stack for labels; `ui-monospace, SFMono-Regular, Menlo, monospace` for runtime logs only.

**Character:** Typography should feel native, sober, and immediately readable. Hierarchy comes from a narrow range of carefully chosen sizes and weights rather than oversized headlines or ornamental contrast.

### Hierarchy

- **Headline** (`typography.headline`): Page, welcome, and about headings; 21px is the absolute ceiling for functional headings.
- **Title** (`typography.title`): Product brand and the strongest compact identity label.
- **Body** (`typography.body`): Messages, descriptive copy, and explanatory text; chat content stays within a 780px reading measure.
- **Label** (`typography.label`): Metadata, field labels, actions, and status text. Uppercase plus tracking is reserved for machine state and compact system headings.

### Named Rules

**The 21-Pixel Ceiling Rule.** Functional screens never use a heading larger than the established 21px headline.

**The Native Voice Rule.** Use the Apple system stack throughout the product; monospace appears only where raw runtime output requires it.

## Layout

The application is a full-height two-plane shell with a 10px outer inset. At standard desktop widths the sidebar is fixed at 232px and the remaining width belongs to the main pane; below 900px the sidebar contracts to 190px while content remains desktop-oriented. The app intentionally enforces a 760px minimum width rather than introducing a mobile navigation pattern.

The sidebar persists across all views. Chat adds a compact 64px model-and-status bar, a centered conversation column no wider than 780px, and a bottom-anchored composer on the same measure. Content pages scroll independently and use fluid horizontal padding from 30px to 70px. Settings content stops at 690px; narrower diagnostic and about pages stop at 920px.

Spacing is compact within controls and spacious between regions. Use the frontmatter scale for recurring gaps and padding, with 24–32px reserved for page boundaries and major section separation. Preserve breathing room in the canvas instead of filling it with cards.

**The Persistent Navigation Rule.** The pale-green sidebar remains a stable spatial anchor; views replace only the main pane.

**The Conversation Measure Rule.** Messages and the composer share the same centered 780px maximum width.

## Elevation & Depth

Depth is mostly tonal and structural. Borders separate adjacent surfaces; only the window-like main pane, active navigation, compact selectors, the composer, and language selection receive restrained ambient shadows. Nothing should look like a floating marketing card.

### Shadow Vocabulary

- **Shell Ambient** (`0 12px 35px rgba(37,52,42,.07)`): The single broad shadow beneath the main pane.
- **Composer Ambient** (`0 5px 18px rgba(36,54,42,.07)`): Separates the bottom composer from scrolling conversation content.
- **Control Hairline** (`0 1px 2px rgba(35,54,42,.04)`): Used on the compact model picker and similarly precise raised controls.
- **Selected Lift** (`0 1px 2px rgba(30,65,44,.05)`): Marks the active navigation item without making it appear detached.
- **Segment Lift** (`0 1px 3px rgba(33,67,45,.1)`): Applied only to the active locale segment.

### Named Rules

**The Tonal-First Rule.** Establish hierarchy with surface color and a one-pixel border before adding a shadow.

## Shapes

The system uses gently rounded rectangles with a controlled radius ladder. Compact identity and selector details use 7–10px corners; panels and cards use 13–15px; the joined application shell uses 18px on its outer corners. Circles are reserved for status dots, while the bonsai mark remains a rounded square. Borders are one pixel and green-biased rather than neutral gray.

Authored icons are outline SVGs with rounded caps and joins, normally 16–20px. They use the current text color, a consistent light stroke, no filled icon library glyphs, and no emoji.

**The One Stroke Rule.** New icons must match the existing authored outline family: rounded caps and joins, restrained 1.4–1.8 strokes, and simple geometry.

## Components

### Leaf Mark

- **Character:** A compact, ownable signature rather than a generic app glyph.
- **Shape:** Rounded square (`components.leaf-mark`) containing the original two-leaf bonsai line drawing and baseline.
- **Usage:** Standard size is 30px; compact selectors use 25px and welcoming or about moments may scale to 44–48px.

### Buttons

- **Shape:** Compact controls use gently rounded 9px corners (`rounded.control`).
- **Primary:** Forest background, white text, 10px by 14px padding (`components.button-primary`); use for start, copy, and other clear commitments.
- **Secondary:** Pale green surface with forest text (`components.button-secondary`); use for quiet navigation actions such as opening model settings.
- **Destructive:** Keep the primary geometry but switch only the background to Clay Stop.
- **Hover / Focus:** Preserve the component's tonal role on hover. Keyboard focus is a 3px translucent forest outline with a 2px offset.
- **Disabled:** Reduce prominence through the implemented muted fill or 42% opacity and remove the pointer cursor.

### Navigation

- **Style:** Full-width sidebar rows combine an 18px authored outline icon with a 13px label, 9px corners, and 9px by 10px padding.
- **Recent chats:** Chat titles use the same readable 13px navigation role, including rename mode. Each title occupies one full-width row with ellipsis only at the actual sidebar edge; automatic titles retain up to 80 characters and expose the full title as a native tooltip. Hidden row actions do not permanently reserve text width.
- **Default / Hover / Active:** Default is transparent; hover adds a translucent white wash; active uses a stronger white wash, darker text, and the Selected Lift shadow.
- **Language Segments:** A compact bordered two-option control; only the selected language receives a white surface and small lift.

### Model Picker

- **Style:** A compact raised-white control in the top bar with the small leaf mark, a two-line 10–11px label, and an authored chevron.
- **Shape:** 10px corners, a hairline border, and 6px by 9px padding (`components.model-picker`).
- **Behavior:** Long filenames truncate; activating the control navigates to model settings.

### Composer

- **Style:** A bottom-anchored white writing surface with an unbordered textarea and square send control.
- **Shape:** 15px corners and a 68px minimum height (`components.composer`).
- **Action:** The 34px forest send button uses the authored upward arrow; its disabled state becomes muted gray-green.
- **Depth:** Use Composer Ambient only, backed by the existing fade from transparent to Main Paper.
- **File drop:** Dragging files over the chat replaces the work area with a calm, high-contrast drop target. PDF/DOCX route to local RAG; images, text and code route to the pending request.
- **Generation state:** Before the first token, show a compact three-dot Bonsai activity indicator beside explicit status text; respect Reduced Motion and remove the indicator as soon as streamed text appears.

### Cards / Containers

- **Corner Style:** System strips and diagnostic groups use 13px corners; the settings form uses 14px corners.
- **Background:** Raised White for editable or grouped information, with a soft tinted surface for the system strip.
- **Shadow Strategy:** No shadow at rest; use hairline borders and internal dividers.
- **Internal Padding:** Information rows use 13–16px; the settings card uses 22px (`components.settings-card`).

### Inputs / Fields

- **Style:** Soft off-white fill, hairline border, 9px corners, compact 11px text, and 10–12px padding (`components.field`). File selectors present the filename and action in one full-width button.
- **Focus:** Use the global forest outline; do not replace it with color-only border changes.
- **Disabled / Error:** Disabled state is visibly subdued. Runtime error detail uses a pale clay surface and wrapped text rather than a modal.

### Status

- **Style:** A 7px semantic dot followed by a compact uppercase label with 0.07em tracking.
- **State:** Gray-green means stopped, Leaf Success means ready, Amber Progress pulses while starting or stopping, and Clay Danger means error.
- **Motion:** The progress pulse lasts 1s and is suppressed by the global reduced-motion rule.

## Do's and Don'ts

### Do:

- **Do** keep the sidebar pale green, persistent, and visually quieter than the work in the main pane.
- **Do** cap functional headings at 21px and rely on spacing and weight for hierarchy.
- **Do** use readable green-biased muted text, retaining the implemented contrast rather than fading metadata into pale gray.
- **Do** keep icons in the same authored rounded-stroke SVG language and reuse the original bonsai leaf identity.
- **Do** make focus, runtime state, disabled state, and reduced motion visible without depending on color alone.

### Don't:

- **Don't** copy ChatGPT or Jan literally, introduce their logos, or replace the GZ Bonsai leaf with a generic AI symbol.
- **Don't** turn the spacious conversation canvas into a grid of floating cards or decorative dashboards.
- **Don't** introduce oversized display typography, gradients as decoration, glassmorphism, or saturated accent colors.
- **Don't** use emoji, filled icon packs, mixed stroke styles, or arbitrary corner radii.
- **Don't** use warning, error, or stop colors outside their semantic runtime and destructive-action roles.
