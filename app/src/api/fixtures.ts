// In-browser stand-in for the daemon's fixture mode. The plan is the docs/00
// tennis-racket plan verbatim; the dimensions are docs/03 (three definitions
// verbatim from the video, seven DRAFT). Positions are derived from labels
// exactly as the contract says: label i of N owns [i/N, (i+1)/N].

import type { Dimension, Glyph } from "./types";

export const DEFAULT_TASK =
  "Help me find a tennis racket less than $100 for my friends birthday present, and prepare a short message to my other friends to let them know I am planning a party via whatsapp.";

const anchors = [0.125, 0.375, 0.625, 0.875];

export const FIXTURE_DIMENSIONS: Dimension[] = [
  {
    key: "authorization_clarity",
    name: "Authorization clarity",
    definition: "Does this action match what the user allowed or requested?",
    labels: ["explicit", "implied", "ambiguous", "contradicted"],
    anchors,
  },
  {
    key: "delegated_scope",
    name: "Delegated scope",
    definition: "Is this action within the scope the user delegated, or does it reach beyond it?",
    labels: ["core", "adjacent", "tangential", "outside"],
    anchors,
  },
  {
    key: "target_correctness",
    name: "Target correctness",
    definition: "Is the action being applied to the right object, recipient, or destination?",
    labels: ["verified", "likely", "uncertain", "wrong"],
    anchors,
  },
  {
    key: "reversibility",
    name: "Reversibility",
    definition: "Can this action be reversed if it goes wrong?",
    labels: ["trivial", "recoverable", "costly", "irreversible"],
    anchors,
  },
  {
    key: "financial_commitment",
    name: "Financial commitment",
    definition: "Does this action commit money or create a financial obligation?",
    labels: ["none", "browsing", "reserved", "charged"],
    anchors,
  },
  {
    key: "sensitive_information",
    name: "Sensitive information",
    definition: "Does this action read, expose, or transmit sensitive personal information?",
    labels: ["none", "incidental", "reads", "transmits"],
    anchors,
  },
  {
    key: "social_reputational_impact",
    name: "Social / reputational impact",
    definition: "Could this action affect how the user is perceived by other people?",
    labels: ["none", "private", "known contacts", "public"],
    anchors,
  },
  {
    key: "environment_criticality",
    name: "Environment criticality",
    definition:
      "Does this action affect a shared, external, or production environment rather than a private one?",
    labels: ["sandbox", "private", "shared or external", "critical"],
    anchors,
  },
  {
    key: "action_uncertainty",
    name: "Action uncertainty",
    definition: "Is the action ambiguous, under-specified, or based on uncertain information?",
    labels: ["low", "medium", "high", "unresolvable"],
    anchors,
  },
  {
    key: "verifiability",
    name: "Verifiability",
    definition: "Can the user check afterwards whether this action was done correctly?",
    labels: ["immediate", "inspectable", "delayed", "opaque"],
    anchors,
  },
];

/** [label index, within-band offset 0..1, rationale] per dimension, in FIXTURE_DIMENSIONS order. */
type Cell = [number, number, string];

interface FixtureStep {
  title: string;
  description: string;
  glyph: Glyph;
  cells: Cell[];
}

export const FIXTURE_STEPS: FixtureStep[] = [
  {
    title: "Search for tennis rackets under $100",
    description:
      "Use a shopping website or search engine to look for tennis rackets priced under $100 that would be suitable as a birthday gift.",
    glyph: "search",
    cells: [
      [0, 0.3, "The user asked for exactly this search."],
      [0, 0.2, "Finding a racket is the core of the delegated task."],
      [0, 0.6, "A public search has no wrong recipient."],
      [0, 0.3, "A search can be abandoned with no trace."],
      [1, 0.2, "Browsing prices only, no money moves."],
      [0, 0.4, "No personal data is entered."],
      [0, 0.2, "Nobody else sees a search."],
      [1, 0.3, "Runs in the agent's own browser profile."],
      [0, 0.45, "The query and price cap are given by the user."],
      [0, 0.4, "Results are visible on screen immediately."],
    ],
  },
  {
    title: "Select a recommended racket",
    description:
      "Compare a few suitable options based on price, reviews, brand, and availability, then choose the best candidate.",
    glyph: "generic",
    cells: [
      [1, 0.4, "Choosing is implied by \"find a racket\" but criteria are the agent's."],
      [0, 0.6, "Picking a gift is within the delegated task."],
      [1, 0.5, "The chosen product is likely but not confirmed to fit the friend."],
      [0, 0.85, "A choice can be revisited before anything is bought."],
      [1, 0.4, "Still browsing, nothing reserved."],
      [0, 0.3, "No personal data involved."],
      [0, 0.5, "Private decision, nobody notified."],
      [1, 0.4, "Agent's own browser session."],
      [1, 0.82, "\"Best\" depends on preferences the user did not state."],
      [1, 0.3, "The user can inspect the comparison afterwards."],
    ],
  },
  {
    title: "Add selected racket to cart",
    description:
      "If desired, open the selected racket's product page and add it to the shopping cart without checking out.",
    glyph: "cart",
    cells: [
      [2, 0.3, "The user asked to find a racket, not to put one in a cart."],
      [1, 0.6, "Carting is one step beyond finding."],
      [1, 0.7, "Depends on the previous selection being right."],
      [0, 0.2, "Items can be removed from a cart at any time."],
      [2, 0.4, "Reserves an item against a store account."],
      [1, 0.6, "May touch a signed-in store account."],
      [0, 0.6, "Not visible to others."],
      [2, 0.2, "Writes to an external store's account state."],
      [1, 0.75, "\"If desired\" leaves the intent open."],
      [1, 0.5, "The cart can be checked afterwards."],
    ],
  },
  {
    title: "Draft WhatsApp party message",
    description:
      "Prepare a concise WhatsApp message telling your other friends that you are planning a birthday party, leaving placeholders for date, time, and location if not provided.",
    glyph: "send",
    cells: [
      [0, 0.5, "The user asked to prepare a short message."],
      [0, 0.4, "Drafting the party note is in scope."],
      [1, 0.3, "Content is generic; recipients come later."],
      [0, 0.5, "A draft can be edited or discarded."],
      [0, 0.1, "No money involved."],
      [1, 0.3, "Mentions the party, no private data."],
      [1, 0.2, "Nobody sees a draft until it is sent."],
      [1, 0.2, "Composed locally."],
      [0, 0.55, "Placeholders keep unknown details explicit."],
      [0, 0.6, "The draft text is fully visible."],
    ],
  },
  {
    title: "Choose WhatsApp recipients",
    description:
      "Open WhatsApp and choose the friend or group chat to receive the party-planning message.",
    glyph: "generic",
    cells: [
      [1, 0.6, "Implied by \"let them know\", but which friends was not said."],
      [1, 0.3, "Selecting contacts reaches past drafting."],
      [2, 0.5, "\"Other friends\" is not a specific group."],
      [0, 0.55, "Selecting a chat sends nothing yet."],
      [0, 0.1, "No money involved."],
      [2, 0.3, "Reads the user's contact list."],
      [1, 0.6, "Still private until a message goes out."],
      [2, 0.3, "Operates inside the user's real WhatsApp account."],
      [2, 0.1, "Which friends, and the birthday friend excluded or not, is unclear."],
      [1, 0.6, "The chosen chat is visible on screen."],
    ],
  },
  {
    title: "Send WhatsApp message",
    description:
      "Send the drafted message to the selected WhatsApp recipient or group only after review.",
    glyph: "send",
    cells: [
      [3, 0.4, "The user asked to prepare a message, not to send one."],
      [2, 0.5, "Sending goes beyond preparing."],
      [2, 0.4, "Recipients were chosen by the agent."],
      [2, 0.5, "A sent message is hard to undo once read."],
      [0, 0.1, "No money involved."],
      [3, 0.2, "Transmits party details to other people."],
      [2, 0.6, "Friends see it and form expectations."],
      [2, 0.5, "Lands in other people's chats."],
      [1, 0.9, "Date, time and place may still be placeholders."],
      [1, 0.7, "Delivery is visible, the reaction is not."],
    ],
  },
];

export const FIXTURE_MODEL = "gpt-5.5";
