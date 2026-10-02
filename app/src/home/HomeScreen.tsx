import { useEffect, useRef, useState } from "react";
import type { Attachment, Provider } from "../api/types";
import type { ScreenProps } from "../screens";
import { providerLabel } from "./attachmentRules";
import { Composer } from "./Composer";
import s from "./HomeScreen.module.css";

// Examples only: a click fills the composer, it never sends (spec: Screens §1).
const SUGGESTIONS: { icon: string; text: string }[] = [
  { icon: "⌕", text: "Compare prices for a product across three stores" },
  { icon: "✎", text: "Draft a reply to my latest email (don't send it)" },
  { icon: "▦", text: "Fill this form using the screenshot I attach" },
];

export function HomeScreen({ api, conn, session }: ScreenProps) {
  const [text, setText] = useState("");
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [provider, setProvider] = useState<Provider | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api.getSettings().then(
      (st) => alive && setProvider(st.provider),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, conn.health?.model]);

  const reason = !conn.reachable
    ? "The daemon is reconnecting…"
    : conn.health && !conn.health.api_key
      ? "Add a model key to start (click the status pill)."
      : null;

  const fill = (t: string) => {
    setText(t);
    requestAnimationFrame(() => wrapRef.current?.querySelector("textarea")?.focus());
  };

  return (
    <div className={s.home}>
      <h1 className={s.title}>What should the agent do?</h1>
      <div className={s.composer} ref={wrapRef}>
        <Composer
          api={api}
          value={text}
          onChange={setText}
          attachments={atts}
          onAttachmentsChange={setAtts}
          allowAttachments
          providerLabel={providerLabel(provider ?? conn.health?.provider)}
          placeholder="Find me a tennis racket under $100 for my friend's birthday…"
          size="hero"
          disabledReason={reason}
          running={false}
          onSend={() => void session.actions.submit(text, atts)}
        />
      </div>
      <div className={s.under}>
        <span className={s.chip} title="Web steps use the agent's own browser profile. Steps that name Messages or Notes use those apps on your Mac.">
          <i className={s.chipDot} /> Chrome (agent's own)
        </span>
      </div>
      <div className={s.sugg}>
        {SUGGESTIONS.map((x) => (
          <button key={x.text} className={s.item} data-testid="home-suggestion" onClick={() => fill(x.text)}>
            <span className={s.icon} aria-hidden>
              {x.icon}
            </span>
            {x.text}
          </button>
        ))}
      </div>
    </div>
  );
}
