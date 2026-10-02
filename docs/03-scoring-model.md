# 03. Scoring model

The grid is only as good as the scores behind it. If placement is noisy or
inconsistent, the boundary gesture becomes theater, because the user is drawing
a line through randomness. This is the part to get right.

## The ten dimensions

Names transcribed from the axis dropdown. Three definitions are verbatim from
the source video. The other seven are drafts, marked DRAFT, and should be
checked with Kyzyl before you lock them, since the definition string is
literally the scorer's prompt.

Labels are proposed ordinal scales. The four marked CONFIRMED-LABEL are ones
observed in the "Why this mattered" panel.

| # | Dimension | Definition | Labels (low to high risk) |
|---|---|---|---|
| 1 | Authorization clarity | "Does this action match what the user allowed or requested?" (verbatim) | explicit, implied, ambiguous, **contradicted** (CONFIRMED-LABEL) |
| 2 | Delegated scope | DRAFT: "Is this action within the scope the user delegated, or does it reach beyond it?" | core, adjacent, **tangential** (CONFIRMED-LABEL), outside |
| 3 | Target correctness | DRAFT: "Is the action being applied to the right object, recipient, or destination?" | verified, likely, uncertain, wrong |
| 4 | Reversibility | "Can this action be reversed if it goes wrong?" (verbatim) | trivial, recoverable, costly, irreversible |
| 5 | Financial commitment | DRAFT: "Does this action commit money or create a financial obligation?" | none, browsing, reserved, charged |
| 6 | Sensitive information | DRAFT: "Does this action read, expose, or transmit sensitive personal information?" | none, incidental, reads, transmits |
| 7 | Social / reputational impact | DRAFT: "Could this action affect how the user is perceived by other people?" | none, private, known contacts, public |
| 8 | Environment criticality | DRAFT: "Does this action affect a shared, external, or production environment rather than a private one?" | sandbox, private, **shared or external** (CONFIRMED-LABEL), critical |
| 9 | Action uncertainty | "Is the action ambiguous, under-specified, or based on uncertain information?" (verbatim) | low, **medium** (CONFIRMED-LABEL), high, unresolvable |
| 10 | Verifiability | DRAFT: "Can the user check afterwards whether this action was done correctly?" | immediate, inspectable, delayed, opaque |

Keep these in `daemon/oversight/dimensions.yaml` with the definition string,
the label list, and a numeric anchor per label. Both the scorer and the axis
tooltips read from that one file.

## Output contract

Per step, per dimension:

```python
{
  "dimension": "authorization_clarity",
  "label": "contradicted",     # from the dimension's label list
  "position": 0.91,            # 0..1 along the axis, low risk to high
  "confidence": 0.84,
  "rationale": "The user asked to prepare a message, not to send one."
}
```

`position` is what places the badge. `label` is what "Why this mattered"
prints. Derive `position` from the label's numeric anchor plus a within-label
offset, so that a badge's position and its printed label can never contradict
each other. Getting this backwards, scoring continuously and bucketing after,
produces cases where the panel says "medium" and the dot sits at the far right,
which destroys user trust in the grid immediately.

## Scoring with Jev

This is the natural fit, and it is the reason Jev matters to this project as
well as to `testing/`.

Jev returns typed, calibrated decisions in 70 to 500ms (313ms p50 on the direct
API), cannot generate free text, and costs $0.042 per million input tokens with
free output. Its three primitives map onto this problem almost exactly:

- **Choice** for the categorical label, up to 255 options, returns the chosen
  option plus a probability distribution plus confidence
- **Score** for the within-label position on a 2 to 10 level labeled spectrum,
  returns a continuous value that can land between levels
- **Noul** for the binary gates (does this commit money at all, does this touch
  a third party at all)

All questions in one request evaluate in parallel with almost no added latency:
measured at roughly 74ms for five questions versus 70ms for one. So a single
call scores one step across all ten dimensions. Six steps is six calls, roughly
two seconds total, and that is your entire "Preparing oversight view" wait.

Sketch:

```python
questions = {}
for d in DIMENSIONS:                       # ten of them
    questions[f"{d.key}_label"] = Choice(
        instructions=d.definition,
        options={lbl: d.label_descriptions[lbl] for lbl in d.labels},
    )
    questions[f"{d.key}_pos"] = Score(
        instructions=f"{d.definition} Rate severity.",
        levels=d.labels,
    )

verdict = clf.invoke({"state": render_step(task, step, plan_context),
                      "questions": questions})
```

Two things the Jev docs call out that matter here:

**It reads literally and accuracy degrades with unnecessary context.** Do not
dump the whole plan into `state`. Give it the task, the step title and
description, and at most a one-line summary of prior steps. Filter in code
first.

**It does not treat its input as adversarial.** In this app the input is
planner output rather than attacker-controlled content, which is a much safer
position than in `testing/`. But if you ever score a step whose description was
derived from web page content, that assumption breaks. Note it and move on.

The confidence value is genuinely load-bearing here, see the uncertainty
rendering improvement in `docs/04-build-plan.md`.

## Fallback scorer

Jev is waitlisted, with gateway access available through OpenRouter, Vercel AI
Gateway, and Cloudflare at worse latency. Put both behind one interface:

```python
class Scorer(Protocol):
    async def score(self, task: Task, step: PlanStep,
                    context: list[PlanStep]) -> list[DimensionScore]: ...
```

`JevScorer` and `LLMScorer`. The LLM version asks a frontier model for the same
JSON shape with structured output. Slower and more expensive, identical
contract. Build `LLMScorer` first so nothing blocks, then swap.

## Consistency

The thing that will actually bite you is instability: the same step scoring
differently across runs, so badges jump and a saved boundary stops meaning what
it meant. Mitigations, in order of value:

1. **Cache by content hash.** Hash the task plus step title plus description.
   Same hash, same scores, always. This alone fixes most of it and makes demos
   reproducible.
2. **Low or zero temperature** on the fallback scorer.
3. **Score the whole plan in one context** so steps are rated relative to each
   other rather than in isolation. "Add to cart" is low financial commitment
   only in contrast to "check out", and a scorer that never sees the checkout
   step will overrate the cart step.
4. **Measure it.** Score the same plan ten times, report the standard deviation
   of each position. If any dimension has an SD above about 0.1 the grid is too
   noisy to draw a meaningful line through, and that dimension's definition
   needs rewriting. This is a half-hour experiment and it tells you whether the
   whole interaction works.

Point 4 is worth doing on day one of the scoring work, not at the end.
