// Wave 0 stub. Track U1 replaces this file; keep the exports and data-testids.
import type { DaemonApi } from "../api/client";
import type { Attachment } from "../api/types";

export interface ComposerProps {
  api: DaemonApi;
  value: string;
  onChange: (v: string) => void;
  attachments: Attachment[];
  onAttachmentsChange: (a: Attachment[]) => void;
  allowAttachments: boolean;
  providerLabel: string;          // "Anthropic" | "OpenAI", for the attachment note
  placeholder: string;
  size: "hero" | "dock";
  disabledReason: string | null;  // non-null disables send and shows the reason
  running: boolean;               // true: the send button becomes Stop
  onSend: () => void;
  onStop?: () => void;
}

export function Composer(p: ComposerProps) {
  return (
    <div style={{ display: "flex", gap: 8, padding: 12 }}>
      <textarea
        data-testid="composer-input"
        value={p.value}
        placeholder={p.placeholder}
        onChange={(e) => p.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !p.disabledReason && !p.running) {
            e.preventDefault();
            p.onSend();
          }
        }}
        style={{ flex: 1 }}
      />
      {p.running ? (
        <button data-testid="composer-stop" onClick={p.onStop}>Stop</button>
      ) : (
        <button data-testid="composer-send" disabled={!!p.disabledReason || !p.value.trim()} onClick={p.onSend}>Send</button>
      )}
    </div>
  );
}
