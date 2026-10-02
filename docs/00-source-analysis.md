# 00. Source analysis

Everything below is observed in the UIST submission video
(`uist26b-sub1120-cam-i19.mov`, 5:09, 1132x720). Stills are in `reference/`.
Anything marked UNCONFIRMED was not visible and needs a decision or a question
to Kyzyl.

## Paper

**Sketch Oversight: Drawing Decision Boundaries for Delegated AI Agent Actions**
Kyzyl Monterio*, Takeshi Koey*, Sauvik Das. Carnegie Mellon University.
UIST 2026, Detroit. (* equal contribution.)

## Narrative structure

| Time | Content |
|---|---|
| 0:00 | Title slide |
| 0:10 | Problem framing (`reference/01-problem-framing.jpg`) |
| 0:20 | "Why existing controls fail": Always allow / Deny / Ask every step |
| 0:35 | "What if you could draw the line for your agent?" |
| 0:40 | Live demo begins, task entry and plan generation |
| 1:10 | "Preparing oversight view. Scoring actions and placing them on the grid" |
| 1:20 | Sketch Oversight grid appears, boundary drawing |
| 1:35 | Axis dimension menus opened (`reference/03-dimension-list.jpg`) |
| 2:00 | Boundary reshaped, approval counts update live |
| 3:45 | Steps removed and struck through (`reference/05-removed-steps.jpg`) |
| 4:10 | "Different Example" interstitial |
| 4:25 | Second example on Authorization clarity x Reversibility axes |
| 4:35 | Approve and Run, execution begins |
| 4:40 | Agent drives real Chrome, Google Shopping search for tennis rackets |
| 5:00 | Results, "Why this mattered", "Boundary candidate" |

## Problem framing, verbatim

> One delegated task can contain actions with very different levels of risk.
>
> Example task: Find a birthday gift and let friends know I'm planning something.
>
> | Search for gift ideas under $50 | Compare options | Draft a message to friends | Buy with saved card |
> | okay | okay | needs judgment | not okay |
>
> Some actions are fine, some need review, and some should stop, all within the
> same task.

Then: "Why existing controls fail: Always allow / Deny / Ask every step."
Then: "What if you could draw the line for your agent?"

This is the pitch and it is worth reproducing verbatim in any demo you record.

## The application

Window title: **Agent Oversight**
Header: **Reflexive Oversight - CUA Agent (cua-driver)**
Status row: green dot **Daemon**, green dot **API key**, model **gpt-5.5**
Status line: "Ready. cua-driver running, API key found, model gpt-5.5."
Secondary status line seen later: "Selected app: Notes"

Tabs: **Plan Review** | **Impact**

The `cua-driver` in the title is trycua's background computer-use agent
package. The app is a front end over that driver plus a local daemon.

## Demo task, verbatim

> Help me find a tennis racket less than $100 for my friends birthday present,
> and prepare a short message to my other friends to let them know I am
> planning a party via whatsapp.

## Generated plan, verbatim

Six steps, each with a title and a description:

1. **Search for tennis rackets under $100**
   "Use a shopping website or search engine to look for tennis rackets priced
   under $100 that would be suitable as a birthday gift."
2. **Select a recommended racket**
   "Compare a few suitable options based on price, reviews, brand, and
   availability, then choose the best candidate."
3. **Add selected racket to cart**
   "If desired, open the selected racket's product page and add it to the
   shopping cart without checking out."
4. **Draft WhatsApp party message**
   "Prepare a concise WhatsApp message telling your other friends that you are
   planning a birthday party, leaving placeholders for date, time, and
   location if not provided."
5. **Choose WhatsApp recipients**
   "Open WhatsApp and choose the friend or group chat to receive the
   party-planning message."
6. **Send WhatsApp message**
   "Send the drafted message to the selected WhatsApp recipient or group only
   after review."

Later in the video step 2 has been edited by the user to **Select a cheapest
racket**, "Use a shopping website or search engine to... sort by price low to
high and select the...", which confirms in-place step editing followed by
re-proposal.

## The ten dimensions

Transcribed from the axis dropdown (`reference/03-dimension-list.jpg`):

1. Authorization clarity
2. Delegated scope
3. Target correctness
4. Reversibility
5. Financial commitment
6. Sensitive information
7. Social / reputational impact
8. Environment criticality
9. Action uncertainty
10. Verifiability

Definitions visible under the axis selectors:

- **Authorization clarity**: "Does this action match what the user allowed or
  requested?"
- **Reversibility**: "Can this action be reversed if it goes wrong?"
- **Action uncertainty**: "Is the action ambiguous, under-specified, or based
  on uncertain information?"

The other seven definitions are UNCONFIRMED. Drafts are proposed in
`docs/03-scoring-model.md` and should be checked with Kyzyl, since the exact
wording is what the scorer is prompted with.

## The oversight grid

Panel header **Sketch Oversight**, with live badges: "2 approved",
"4 pending", and a removed count when steps are removed.
Sub-line: "Viewing through: Action uncertainty x Reversibility".

Section **Review axes**:
- X-axis dropdown, Y-axis dropdown, each over the full ten dimensions
- The selected dimension's definition renders directly under its dropdown

Instruction line, verbatim:
> Draw boundary - drag handles to reshape - double-click edge to add handle

with a **Clear** button at the right.

The plot itself: axes labeled Low to High on both, axis name centered on each
edge. Actions render as circular badges containing a glyph suggesting the
action type (magnifier for search, paper plane for send, cart for add to cart).

Legend: green **Approved**, orange **Pending approval**, grey **Removed**.

The boundary is a **freeform closed polygon** drawn in green, with visible
round vertex handles that can be dragged. Actions whose plotted point falls
inside turn green. Everything outside stays orange. Counts in the header update
live as the polygon is reshaped.

In the second example the axes are switched to Authorization clarity x
Reversibility (`reference/06-second-example-axes.jpg`), confirming the grid is
a 2D projection of a 10-dimensional score vector and the user picks the slice.

## The plan panel

Header **Review the plan** with a **Select All** button.
Sub-line: "Check steps to accept. Uncheck and re-propose to change them."

Each step card carries: a checkbox, a glyph, index and title, the description,
and on the right a pencil (edit) and a circled X (remove).

Removed steps render struck through with the label
"Removed by oversight - excluded" and an Undo affordance.

## Footer

Buttons: **Start over**, **Re-propose plan**, **Approve & Run**.
Hint text, verbatim:
> Select all actions (draw a region or check them) to enable Approve & Run.

So Approve & Run is disabled until every step is resolved, and there are two
equivalent ways to resolve them: the polygon, or the checkboxes. They are two
views on the same approved set.

## Execution view

Replaces the plan review after Approve & Run.

**Plan progress**, a checklist with green checks per completed step. In the
final state it shows steps 1, 2, and 4, with 3 absent because it was removed,
and the numbering preserves the original indices.

**Proposed actions and results**, a collapsible log.
Live entries seen: "Executing plan" with an elapsed timer, "approved step(s)",
"Considerations scored", a running cost figure, and per-step results.

**Removed action** block: struck-through "Send WhatsApp message", followed by
"Task continued with -> Remaining steps in the plan".

**Final result** block, green: "All approved steps were attempted."

A **New task** button.

During execution the agent drives a real Chrome window through Google and
Google Shopping, searching "tennis rackets under $100 birthday gift". The
oversight window stays floating above it.

## "Why this mattered"

(`reference/08-why-this-mattered.jpg`) A panel explaining why a specific action
was flagged, listing per-dimension categorical verdicts:

- Action uncertainty: **medium**
- Authorization clarity: **contradicted**
- Delegated scope: **tangential**
- Environment criticality: **shared or external**

This is the single most informative frame in the video, because it proves the
dimensions carry **categorical labels**, not just continuous scores. The grid
position is presumably derived from the label plus a within-label position.
Design your scoring output to produce both.

## "Boundary candidate"

Directly below, a panel titled **Boundary candidate**:

> **External communications require approval**
> Source action: Send WhatsApp message
> *Preview only - not stored*

This is the reflexive part of "Reflexive Oversight". The system generalizes the
user's removal of a specific step into a **reusable natural-language policy
rule**, and shows it back to them.

Note "Preview only - not stored". In the paper's own system the generalized
rule is proposed but never persisted or applied. That is the most obvious
unfinished edge in the design and it is where "1-to-1 or better" has the most
room. See the improvements list in `docs/04-build-plan.md`.

## Open questions

- **The Impact tab is never opened in the video.** Its contents are entirely
  UNCONFIRMED. Ask Kyzyl. Best guess is aggregate consequence framing across
  the plan, a counterpart to the per-action Plan Review view.
- The seven unconfirmed dimension definitions.
- Whether grid position is derived from the categorical label, scored
  continuously and then bucketed into a label, or produced independently.
- Whether "Selected app: Notes" means the user scopes the agent to one
  application before planning, or it reflects whatever app is frontmost.
- Whether boundaries persist across tasks at all in the original, given the
  boundary candidate is explicitly not stored.
