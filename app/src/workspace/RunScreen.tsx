// Running and done: the chat narrates, the desk shows what the model sees.
import { useMemo, useState } from "react";
import type { Attachment } from "../api/types";
import { ChatThread } from "../chat/ChatThread";
import { eventsToMessages } from "../chat/eventsToMessages";
import { Composer } from "../home/Composer";
import type { ScreenProps } from "../screens";
import { DeskView } from "./DeskView";
import s from "./RunScreen.module.css";

export function RunScreen({ api, conn, session }: ScreenProps) {
  const { state, actions } = session;
  const [draft, setDraft] = useState("");
  const [atts, setAtts] = useState<Attachment[]>([]);
  const running = state.phase === "running";
  const messages = useMemo(
    () => eventsToMessages({ prompt: state.prompt, attachments: state.attachments, steps: state.steps, events: state.events, planError: null }),
    [state.prompt, state.attachments, state.steps, state.events],
  );
  // Done: the composer starts a fresh task. `submit` dispatches start_task, which resets
  // the session, so the screen switches straight to planning with no flash of Home.
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const a = atts;
    setDraft("");
    setAtts([]);
    void actions.submit(text, a);
  };
  return (
    <div className={s.screen}>
      <section className={s.chat}>
        <ChatThread api={api} messages={messages} counts={null} meta={null} events={state.events} steps={state.steps} />
        <div className={s.dock}>
          <Composer api={api} value={draft} onChange={setDraft} attachments={atts} onAttachmentsChange={setAtts}
            allowAttachments={!running} providerLabel={conn.health?.provider === "openai" ? "OpenAI" : "Anthropic"}
            placeholder={running ? "The agent is working. Stop it any time." : "Start a new task…"} size="dock"
            disabledReason={null} running={running} onSend={send} onStop={() => void actions.stop()} />
        </div>
      </section>
      <section className={s.workspace}>
        {state.taskId && state.run && (
          <DeskView api={api} taskId={state.taskId} events={state.events} steps={state.steps} run={state.run} />
        )}
      </section>
    </div>
  );
}
