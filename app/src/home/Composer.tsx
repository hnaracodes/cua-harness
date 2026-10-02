// The one composer (home hero and chat dock). Controlled text and attachments; uploads
// go through DaemonApi.uploadAttachment, and each file gets its own chip and error.
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import type { DaemonApi } from "../api/client";
import type { Attachment } from "../api/types";
import { formatBytes, validateImage } from "./attachmentRules";
import s from "./Composer.module.css";

export interface ComposerProps {
  api: DaemonApi;
  value: string;
  onChange: (v: string) => void;
  attachments: Attachment[];
  onAttachmentsChange: (a: Attachment[]) => void;
  allowAttachments: boolean;
  providerLabel: string; // "Anthropic" | "OpenAI", for the attachment note
  placeholder: string;
  size: "hero" | "dock";
  disabledReason: string | null; // non-null disables send and shows the reason
  running: boolean; // true: the send button becomes Stop
  onSend: () => void;
  onStop?: () => void;
}

interface Local {
  key: string;
  name: string;
  preview: string;
  error: string | null; // null while uploading
}

let seq = 0;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Composer(p: ComposerProps) {
  const [local, setLocal] = useState<Local[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const latest = useRef(p);
  latest.current = p;
  // Accumulates attachments between a resolve and the parent's re-render, so two uploads
  // finishing back to back never overwrite each other.
  const attRef = useRef(p.attachments);
  useEffect(() => {
    attRef.current = p.attachments;
  }, [p.attachments]);
  const localRef = useRef(local);
  localRef.current = local;
  useEffect(() => () => localRef.current.forEach((l) => URL.revokeObjectURL(l.preview)), []);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [p.value]);

  const uploading = local.some((l) => l.error === null);
  const canSend = !p.disabledReason && !uploading && p.value.trim().length > 0;

  const drop = (key: string) =>
    setLocal((cur) => {
      const hit = cur.find((l) => l.key === key);
      if (hit) URL.revokeObjectURL(hit.preview);
      return cur.filter((l) => l.key !== key);
    });

  const addFiles = (files: File[]) => {
    if (!latest.current.allowAttachments || files.length === 0) return;
    let count = attRef.current.length + localRef.current.filter((l) => l.error === null).length;
    const added: Local[] = [];
    for (const f of files) {
      const key = `up${++seq}`;
      const error = validateImage(f, count);
      added.push({ key, name: f.name || "image", preview: URL.createObjectURL(f), error });
      if (error) continue;
      count += 1;
      latest.current.api.uploadAttachment(f, f.name || "image").then(
        (att) => {
          drop(key);
          attRef.current = [...attRef.current, att];
          latest.current.onAttachmentsChange(attRef.current);
        },
        (e) => setLocal((cur) => cur.map((l) => (l.key === key ? { ...l, error: errText(e) } : l))),
      );
    }
    setLocal((cur) => [...cur, ...added]);
  };

  const removeAttachment = (id: string) => {
    attRef.current = attRef.current.filter((a) => a.attachment_id !== id);
    p.onAttachmentsChange(attRef.current);
  };

  const send = () => {
    if (!canSend) return;
    setLocal((cur) => {
      cur.filter((l) => l.error !== null).forEach((l) => URL.revokeObjectURL(l.preview));
      return cur.filter((l) => l.error === null);
    });
    p.onSend();
  };

  const onDragOver = (e: DragEvent) => {
    if (!p.allowAttachments || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDrop = (e: DragEvent) => {
    if (!p.allowAttachments) return;
    e.preventDefault();
    setDragging(false);
    addFiles([...e.dataTransfer.files]);
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length || !p.allowAttachments) return;
    e.preventDefault();
    addFiles(files);
  };

  return (
    <div className={s.wrap}>
      <div
        className={`${s.box} ${p.size === "dock" ? s.dock : ""} ${dragging ? s.dragging : ""}`}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {(p.attachments.length > 0 || local.length > 0) && (
          <div className={s.chips}>
            {p.attachments.map((a) => (
              <div key={a.attachment_id} className={s.chip} data-testid="attachment-chip" title={`${a.mime}, ${formatBytes(a.bytes)}`}>
                <img src={p.api.attachmentUrl(a.attachment_id)} alt="Attached image" />
                <button className={s.remove} aria-label="Remove image" onClick={() => removeAttachment(a.attachment_id)}>
                  ×
                </button>
              </div>
            ))}
            {local.map((l) =>
              l.error ? (
                <div key={l.key} className={`${s.chip} ${s.bad}`} data-testid="attachment-chip">
                  <span data-testid="attachment-error">
                    {l.name}: {l.error}
                  </span>
                  <button className={s.remove} aria-label="Dismiss" onClick={() => drop(l.key)}>
                    ×
                  </button>
                </div>
              ) : (
                <div key={l.key} className={s.chip} data-testid="attachment-chip" aria-busy="true" title={`Uploading ${l.name}`}>
                  <img src={l.preview} alt="" />
                  <span className={s.spin} />
                </div>
              ),
            )}
          </div>
        )}
        <textarea
          ref={taRef}
          className={s.input}
          data-testid="composer-input"
          rows={1}
          value={p.value}
          placeholder={p.placeholder}
          onChange={(e) => p.onChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (!p.running) send();
          }}
        />
        <div className={s.row}>
          {p.allowAttachments && (
            <>
              <button className={s.iconBtn} data-testid="composer-attach" aria-label="Attach images" title="Attach images" onClick={() => fileRef.current?.click()}>
                +
              </button>
              <input
                ref={fileRef}
                className={s.hidden}
                data-testid="composer-file"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                onChange={(e) => {
                  addFiles([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
            </>
          )}
          {p.running ? (
            <button className={s.stop} data-testid="composer-stop" onClick={p.onStop}>
              ■ Stop
            </button>
          ) : (
            <button className={s.send} data-testid="composer-send" aria-label="Send" disabled={!canSend} onClick={send}>
              ↑
            </button>
          )}
        </div>
      </div>
      {p.attachments.length > 0 && <div className={s.note}>Sent to {p.providerLabel} with your task.</div>}
      {p.disabledReason && <div className={s.reason}>{p.disabledReason}</div>}
    </div>
  );
}
