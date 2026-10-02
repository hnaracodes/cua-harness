# 02. UI spec

Build against `reference/`. Every claim here is from a frame. Measurements are
approximate, the source video is 1132x720 so exact pixel values are not
recoverable and should not be guessed at with false precision.

## Window

Standard macOS window, title **Agent Oversight**, traffic lights, resizable.
It floats above other applications during execution, since in the source the
agent drives Chrome underneath while the oversight window stays visible.

## Header block

```
Reflexive Oversight - CUA Agent (cua-driver)          [large, semibold]
● Daemon   ● API key   gpt-5.5                        [status pills, mono model]
Ready. cua-driver running, API key found, model gpt-5.5.   [secondary, small]
Selected app: Notes                                   [secondary, when set]
```

Green dots for healthy. The model identifier renders in a monospaced face in
the source. Reproduce both status dots as live health checks, not decoration:
Daemon reflects the daemon socket, API key reflects a successful key load.

## Tabs

`Plan Review` | `Impact`, pill-style segmented control, left aligned under the
header. Plan Review is the default and the only one specified, because the
Impact tab is never opened in the source video.

## Task boundary card

A rounded card with a small target glyph and the label **Task boundary**,
containing the task prompt as editable text. Full width.

Before a plan exists there is a **Generate plan** button. While planning, the
card area shows a **Planning** state, then a transitional panel reading:

> Preparing oversight view...
> Scoring actions and placing them on the grid.

with a spinner. Keep this. It is doing real work (ten dimensions times six
steps) and the honest progress message is better than a fake instant render.

## Layout after planning

Two columns. Left roughly two thirds is the Sketch Oversight grid. Right
roughly one third is the plan panel. Both scroll independently. A footer bar
spans the full width.

## Sketch Oversight panel

```
Sketch Oversight
● 2 approved   ◷ 4 pending   [● N removed, when nonzero]
Viewing through: Action uncertainty × Reversibility

Review axes
  X-axis: [ Action uncertainty        ▾ ]    Y-axis: [ Reversibility       ▾ ]
  Is the action ambiguous, under-           Can this action be reversed if
  specified, or based on uncertain          it goes wrong?
  information?

Draw boundary · drag handles to reshape · double-click edge to add handle   [Clear]

  High ┌──────────────────────────────────────────────┐
   R   │                                              │
   e   │                      (badge)                 │
   v   │                                              │
   e   │        ╭──────────╮      (badge)             │
   r   │       ╱            ╲   (badge)               │
   s   │   (badge)  (badge)  │                        │
   i   │       ╲____________╱   (badge)               │
   b   │                                              │
   .   │                                              │
   Low └──────────────────────────────────────────────┘
       Low            Action uncertainty           High

● Approved   ● Pending approval   ● Removed
```

**Axis selectors.** Dropdowns over all ten dimensions. The selected
dimension's definition renders immediately below its selector, in secondary
text. That string must be byte-identical to the one the scorer was prompted
with.

**Badges.** Circular, filled with the status color, containing a white glyph
suggesting the action type (magnifier for search, paper plane for send/draft,
cart for add to cart). Diameter roughly 26pt. Clicking a badge selects and
scrolls to its step card, and vice versa. Hover shows the step title plus the
two axis rationales.

**The boundary.** A closed freeform polygon, green stroke at about 2pt, fill
at low alpha. Round handles at each vertex, about 8pt, draggable. Double-click
on an edge inserts a vertex there. Clear removes the polygon entirely and
returns every step to pending.

Drawing: press and drag on empty grid to lay down a freehand path, which
closes and simplifies into a handled polygon on release. Simplify with
Ramer-Douglas-Peucker to something like 6 to 10 handles so it stays draggable.

**Live reclassification.** During any drag, on every frame, recompute which
badges are inside and update their color and the header counts. Do not wait
for mouse up.

## Plan panel

```
Review the plan                                        [ Select All ]
Check steps to accept. Uncheck and re-propose to change them.

┌─────────────────────────────────────────────────────┐
│ ☑  🔍 1. Search for tennis rackets under $100   ✏ ⊗ │
│     Use a shopping website or search engine to      │
│     look for tennis rackets priced under $100 that  │
│     would be suitable as a birthday gift.           │
└─────────────────────────────────────────────────────┘
```

Checked cards get a tinted background and a colored left edge matching the
approved state. Pencil opens inline editing of title and description. Circled
X removes.

**Removed steps** render struck through with the label
"Removed by oversight - excluded" and an Undo control.

Checkbox and polygon are two views on one approved set. Checking a step moves
nothing on the grid, it just marks it approved. The header counts reflect the
union.

## Footer

```
[ Start over ]                    [ ⟳ Re-propose plan ]  [ ▶ Approve & Run ]
                       Select all actions (draw a region or check them) to enable Approve & Run.
```

Approve & Run is disabled while any step is pending. The hint line is verbatim
from the source, keep it.

## Execution view

Replaces the two-column layout.

```
Plan progress
 ✓ 1. Search for tennis rackets under $100
 ✓ 2. Select a cheapest racket
 ✓ 4. Draft party message
[ New task ]

Removed action
 ⊗ S̶e̶n̶d̶ ̶W̶h̶a̶t̶s̶A̶p̶p̶ ̶m̶e̶s̶s̶a̶g̶e̶
Task continued with
 → Remaining steps in the plan

⚑ Final result
All approved steps were attempted.

⚠ Why this mattered
 ● Action uncertainty: medium
 ● Authorization clarity: contradicted
 ● Delegated scope: tangential
 ● Environment criticality: shared or external

◇ Boundary candidate
 ● External communications require approval
   Source action: Send WhatsApp message
   Preview only - not stored

› Proposed actions and results          [collapsible log]
```

Note the preserved original indices: 1, 2, 4, with 3 removed. Do not renumber.

The collapsible log streams live during execution with entries for
"Executing plan" plus elapsed timer, "approved step(s)", "Considerations
scored", a running cost, and per-step results.

## Theme

Dark, translucent material background, the standard macOS vibrancy look.
Green for approved and success, orange for pending and warnings, red for
removed, blue for informational and boundary candidates. High contrast on the
grid, since the badges must read against the vibrancy.
