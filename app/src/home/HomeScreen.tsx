// Wave 0 stub. Track U1 replaces this file; keep the exports and data-testids.
import { useState } from "react";
import type { Attachment } from "../api/types";
import type { ScreenProps } from "../screens";
import { Composer } from "./Composer";

export function HomeScreen({ api, session }: ScreenProps) {
  const [text, setText] = useState("");
  const [atts, setAtts] = useState<Attachment[]>([]);
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
      <div style={{ width: 640 }}>
        <h1>What should the agent do?</h1>
        <Composer api={api} value={text} onChange={setText} attachments={atts} onAttachmentsChange={setAtts} allowAttachments
          providerLabel="Anthropic" placeholder="Describe a task…" size="hero" disabledReason={null} running={false}
          onSend={() => void session.actions.submit(text, atts)} />
      </div>
    </div>
  );
}
