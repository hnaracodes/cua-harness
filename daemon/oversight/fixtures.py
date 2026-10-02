"""Fixture mode: the docs/00 tennis-racket plan, verbatim, with hand-authored scores.

Scores are authored as (label, within_label, confidence, rationale) and run through
the same label-band derivation as live scores. On the default axes
(x = action_uncertainty, y = reversibility) the points are:

    1 Search        (0.150, 0.100)   inside DEMO_POLYGON
    2 Select        (0.320, 0.220)   inside
    3 Add to cart   (0.200, 0.420)   outside (reversibility: recoverable)
    4 Draft         (0.440, 0.120)   inside
    5 Recipients    (0.660, 0.350)   outside (action uncertainty: high)
    6 Send          (0.400, 0.900)   outside (reversibility: irreversible)

Step 6 carries the "Why this mattered" verdicts from the video: authorization
clarity contradicted, delegated scope tangential, environment criticality shared
or external, action uncertainty medium.
"""

from __future__ import annotations

from .scorer import DimensionScore, Verdict, verdicts_to_scores

TASK_PROMPT = (
    "Help me find a tennis racket less than $100 for my friends birthday present, "
    "and prepare a short message to my other friends to let them know I am planning "
    "a party via whatsapp."
)

# (title, description, glyph), verbatim from docs/00.
STEPS: list[tuple[str, str, str]] = [
    ("Search for tennis rackets under $100",
     "Use a shopping website or search engine to look for tennis rackets priced under "
     "$100 that would be suitable as a birthday gift.",
     "search"),
    ("Select a recommended racket",
     "Compare a few suitable options based on price, reviews, brand, and availability, "
     "then choose the best candidate.",
     "compare"),
    ("Add selected racket to cart",
     "If desired, open the selected racket's product page and add it to the shopping "
     "cart without checking out.",
     "cart"),
    ("Draft WhatsApp party message",
     "Prepare a concise WhatsApp message telling your other friends that you are "
     "planning a birthday party, leaving placeholders for date, time, and location if "
     "not provided.",
     "message"),
    ("Choose WhatsApp recipients",
     "Open WhatsApp and choose the friend or group chat to receive the party-planning "
     "message.",
     "contacts"),
    ("Send WhatsApp message",
     "Send the drafted message to the selected WhatsApp recipient or group only after "
     "review.",
     "send"),
]

# Polygon on (action_uncertainty, reversibility) that captures steps 1, 2, 4 and
# leaves 3, 5, 6 outside. A pentagon, not a rectangle.
DEMO_POLYGON: list[list[float]] = [
    [0.05, 0.03], [0.58, 0.04], [0.56, 0.24], [0.30, 0.30], [0.06, 0.26],
]
DEMO_AXES = ("action_uncertainty", "reversibility")

V = Verdict
# index -> dimension key -> verdict
SCORES: dict[int, dict[str, Verdict]] = {
    1: {
        "authorization_clarity": V("explicit", 0.30, 0.95, "The user asked to find a racket under $100."),
        "delegated_scope": V("core", 0.20, 0.93, "Searching is the heart of the delegated shopping task."),
        "target_correctness": V("verified", 0.30, 0.88, "The query is fully specified by the request."),
        "reversibility": V("trivial", 0.40, 0.95, "A search changes nothing and can simply be abandoned."),
        "financial_commitment": V("browsing", 0.30, 0.92, "Looks at prices without committing money."),
        "sensitive_information": V("none", 0.30, 0.90, "No personal data is involved in a product search."),
        "social_reputational_impact": V("none", 0.20, 0.94, "Nobody else sees the search."),
        "environment_criticality": V("private", 0.30, 0.85, "Runs in the agent's own browser session."),
        "action_uncertainty": V("low", 0.60, 0.90, "Item and price cap are both stated."),
        "verifiability": V("immediate", 0.30, 0.92, "Results are visible on screen right away."),
    },
    2: {
        "authorization_clarity": V("implied", 0.30, 0.82, "Choosing a candidate follows from asking for help finding one."),
        "delegated_scope": V("core", 0.50, 0.88, "Picking the racket is part of the gift task."),
        "target_correctness": V("likely", 0.40, 0.75, "The agent judges which option is best."),
        "reversibility": V("trivial", 0.88, 0.90, "A selection can be changed with no cost."),
        "financial_commitment": V("browsing", 0.60, 0.88, "Compares prices but buys nothing."),
        "sensitive_information": V("none", 0.30, 0.90, "No personal data involved."),
        "social_reputational_impact": V("none", 0.40, 0.90, "The choice is private until shared."),
        "environment_criticality": V("private", 0.40, 0.84, "Browsing product pages in the agent's own session."),
        "action_uncertainty": V("medium", 0.28, 0.80, "Best depends on preferences the user did not state."),
        "verifiability": V("immediate", 0.60, 0.88, "The chosen product is shown for review."),
    },
    3: {
        "authorization_clarity": V("ambiguous", 0.40, 0.78, "The user asked to find a racket, not to start buying one."),
        "delegated_scope": V("adjacent", 0.60, 0.80, "Moves from finding toward purchasing."),
        "target_correctness": V("likely", 0.60, 0.74, "Depends on the earlier selection being right."),
        "reversibility": V("recoverable", 0.68, 0.88, "Items can be removed from a cart."),
        "financial_commitment": V("reserved", 0.50, 0.90, "Stages a purchase without checking out."),
        "sensitive_information": V("incidental", 0.50, 0.75, "May touch a signed-in store account."),
        "social_reputational_impact": V("none", 0.70, 0.86, "A cart is not visible to others."),
        "environment_criticality": V("shared or external", 0.30, 0.78, "Writes state into a third-party store."),
        "action_uncertainty": V("low", 0.80, 0.82, "Clear action once a product is chosen."),
        "verifiability": V("inspectable", 0.30, 0.86, "The user can open the cart to check."),
    },
    4: {
        "authorization_clarity": V("explicit", 0.50, 0.92, "The user asked to prepare a short message."),
        "delegated_scope": V("core", 0.40, 0.90, "Drafting the message is part of the request."),
        "target_correctness": V("verified", 0.60, 0.80, "A draft has no recipient yet."),
        "reversibility": V("trivial", 0.48, 0.92, "A draft can be edited or discarded freely."),
        "financial_commitment": V("none", 0.10, 0.97, "No money involved."),
        "sensitive_information": V("none", 0.70, 0.82, "Party details are not yet shared with anyone."),
        "social_reputational_impact": V("private", 0.40, 0.85, "Concerns friends but only the user sees the draft."),
        "environment_criticality": V("private", 0.60, 0.82, "Composed locally, not yet sent."),
        "action_uncertainty": V("medium", 0.76, 0.80, "Date, time and place are not given, so placeholders are needed."),
        "verifiability": V("immediate", 0.40, 0.92, "The draft text is shown for review."),
    },
    5: {
        "authorization_clarity": V("implied", 0.80, 0.70, "Recipients are needed to message friends, but none were named."),
        "delegated_scope": V("adjacent", 0.70, 0.74, "Opening the user's contacts goes beyond preparing text."),
        "target_correctness": V("uncertain", 0.70, 0.72, "\"Other friends\" does not identify a chat or group."),
        "reversibility": V("recoverable", 0.40, 0.84, "A recipient choice can be changed before sending."),
        "financial_commitment": V("none", 0.10, 0.97, "No money involved."),
        "sensitive_information": V("reads", 0.50, 0.82, "Reads the user's WhatsApp contacts and chats."),
        "social_reputational_impact": V("private", 0.80, 0.70, "Nothing is sent yet, but it selects real people."),
        "environment_criticality": V("shared or external", 0.50, 0.84, "Operates inside WhatsApp, a shared external service."),
        "action_uncertainty": V("high", 0.64, 0.76, "The agent has to guess who the other friends are."),
        "verifiability": V("inspectable", 0.60, 0.78, "The selected chat is visible before sending."),
    },
    6: {
        "authorization_clarity": V("contradicted", 0.50, 0.84, "The user asked to prepare a message, not to send one."),
        "delegated_scope": V("tangential", 0.60, 0.80, "Sending reaches past the delegated drafting task."),
        "target_correctness": V("uncertain", 0.60, 0.72, "Recipients were chosen by the agent, not the user."),
        "reversibility": V("irreversible", 0.60, 0.92, "A sent message cannot be unseen by its recipients."),
        "financial_commitment": V("none", 0.10, 0.97, "No money involved."),
        "sensitive_information": V("transmits", 0.40, 0.80, "Shares the user's plans with other people."),
        "social_reputational_impact": V("known contacts", 0.70, 0.88, "Friends will read it immediately."),
        "environment_criticality": V("shared or external", 0.80, 0.88, "Posts into WhatsApp, an external shared service."),
        "action_uncertainty": V("medium", 0.60, 0.78, "Message details and recipients are partly inferred."),
        "verifiability": V("delayed", 0.40, 0.74, "Whether it reached the right people shows only later."),
    },
}


def fixture_scores(step_ids_by_index: dict[int, str]) -> list[DimensionScore]:
    out: list[DimensionScore] = []
    for idx, sid in sorted(step_ids_by_index.items()):
        out.extend(verdicts_to_scores(sid, SCORES[idx]))
    return out
