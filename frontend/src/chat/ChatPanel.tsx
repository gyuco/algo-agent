import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { FILE_ACCESS_KEY } from "../agents/labels";
import type { AgentResource } from "../agents/api";
import type { ConnectionStatus } from "../connections/api";
import type { MessageKey } from "../i18n/messages";
import { useI18n } from "../i18n/useI18n";
import { chatApi, type Workspace } from "./api";
import {
  AgentTrail,
  DelegationCard,
  DelegationView,
  ToolList,
  type Delegation,
  type Tool,
} from "./Delegations";
import {
  ACCEPT,
  AttachmentError,
  MAX_ATTACHMENTS,
  isImage,
  previewUrl,
  readAttachment,
  type Attachment,
  type AttachmentProblem,
} from "./attachments";

interface Message {
  id: number;
  role: "user" | "assistant";
  text: string;
  attachments?: Attachment[];
  tools: Tool[];
  /** Tasks the main thread handed to the project's agents during this reply. */
  delegations: Delegation[];
  error?: string;
  meta?: string;
  streaming?: boolean;
}

const ATTACHMENT_KEY: Record<AttachmentProblem, MessageKey> = {
  unsupported: "attach.unsupported",
  tooLarge: "attach.tooLarge",
  readFailed: "attach.readFailed",
};

interface Props {
  projectId: number;
  /** Project folder the agent works in. */
  path: string;
  /** Agents switched on in the project. */
  agents: AgentResource[];
  /** Connected providers, whose models the chat offers. */
  connections: ConnectionStatus[];
  /** Provider details a turn reported, e.g. Claude's plan usage. */
  onUsage: (provider: string, details: Record<string, unknown>) => void;
}

/**
 * Chat inside one folder, with an agent or straight with the model, which may
 * then delegate to the project's agents. Remount it (key) to switch folders.
 */
export function ChatPanel({
  projectId,
  path,
  agents,
  connections,
  onUsage,
}: Props) {
  const { t } = useI18n();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  /** '' chats with the model directly. */
  const [agentKey, setAgentKey] = useState("");
  const agent = agents.find((a) => a.key === agentKey);
  /** Delegation shown in place of the main thread; null shows the main thread. */
  const [focus, setFocus] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [sessionId, setSessionId] = useState<string | undefined>();
  /** Provider the conversation runs on: it can't move to another one. */
  const [sessionProvider, setSessionProvider] = useState<string | undefined>();
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** Follow new output only while the user is at the bottom, so scrolling up to read isn't undone. */
  const stickRef = useRef(true);

  useEffect(() => {
    const list = listRef.current;
    if (list && stickRef.current) list.scrollTop = list.scrollHeight;
  }, [messages]);

  // Grow the textarea with its content, up to the CSS max-height.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  function onScroll() {
    const list = listRef.current;
    if (list)
      stickRef.current =
        list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  }

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    chatApi
      .workspace(path)
      .then(setWorkspace, (err: unknown) =>
        setWorkspaceError(
          err instanceof Error ? err.message : t("workspace.invalidFolder"),
        ),
      );
  }, [path, t]);

  function update(id: number, change: (m: Message) => Message) {
    setMessages((list) => list.map((m) => (m.id === id ? change(m) : m)));
  }

  function updateDelegation(
    id: number,
    delegation: string,
    change: (d: Delegation) => Delegation,
  ) {
    update(id, (m) => ({
      ...m,
      delegations: m.delegations.map((d) =>
        d.id === delegation ? change(d) : d,
      ),
    }));
  }

  const delegations = messages.flatMap((m) => m.delegations);
  const focused = delegations.find((d) => d.id === focus);

  /** Translated reason a file couldn't be attached. */
  function attachmentMessage(err: unknown) {
    if (err instanceof AttachmentError)
      return t(ATTACHMENT_KEY[err.problem], { name: err.fileName });
    return t("chat.attachInvalid");
  }

  async function attach(files: Iterable<File>) {
    setAttachError(null);
    const list = [...files];
    const room = MAX_ATTACHMENTS - attachments.length;
    if (list.length > room) {
      setAttachError(
        t("chat.maxAttachments", { max: String(MAX_ATTACHMENTS) }),
      );
    }
    const results = await Promise.allSettled(
      list
        .slice(0, Math.max(room, 0))
        .map((file) => readAttachment(file, t("chat.pastedName"))),
    );
    const read = results.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    const failed = results.find((r) => r.status === "rejected");
    if (failed) setAttachError(attachmentMessage(failed.reason));
    setAttachments((current) =>
      [...current, ...read].slice(0, MAX_ATTACHMENTS),
    );
    inputRef.current?.focus();
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files];
    if (files.length === 0) return;
    e.preventDefault();
    void attach(files);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (workspace && !streaming) void attach(e.dataTransfer.files);
  }

  async function send() {
    const text = input.trim();
    const files = attachments;
    if (!workspace || (!text && files.length === 0) || streaming) return;
    const userId = nextId.current++;
    const replyId = nextId.current++;
    setMessages((list) => [
      ...list,
      {
        id: userId,
        role: "user",
        text,
        attachments: files,
        tools: [],
        delegations: [],
      },
      {
        id: replyId,
        role: "assistant",
        text: "",
        tools: [],
        delegations: [],
        streaming: true,
      },
    ]);
    setInput("");
    setAttachments([]);
    setAttachError(null);
    stickRef.current = true;
    setStreaming(true);
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const events = chatApi.send(
        {
          projectId,
          agent: agent?.key,
          message: text,
          attachments: files.length ? files : undefined,
          sessionId,
          model: model || undefined,
        },
        abort.signal,
      );
      for await (const event of events) {
        switch (event.type) {
          case "session":
            setSessionId(event.sessionId);
            setSessionProvider(event.provider);
            break;
          case "text":
            if (event.delegation) {
              updateDelegation(replyId, event.delegation, (d) => ({
                ...d,
                text: d.text + event.text,
              }));
            } else {
              update(replyId, (m) => ({ ...m, text: m.text + event.text }));
            }
            break;
          case "tool": {
            const tool = { name: event.name, target: event.target };
            if (event.delegation) {
              updateDelegation(replyId, event.delegation, (d) => ({
                ...d,
                tools: [...d.tools, tool],
              }));
            } else {
              update(replyId, (m) => ({ ...m, tools: [...m.tools, tool] }));
            }
            break;
          }
          case "delegation":
            update(replyId, (m) => ({
              ...m,
              delegations: [
                ...m.delegations,
                {
                  id: event.id,
                  agent: event.agent,
                  description: event.description,
                  prompt: event.prompt,
                  text: "",
                  tools: [],
                  status: "running",
                },
              ],
            }));
            break;
          case "delegation_done":
            updateDelegation(replyId, event.id, (d) => ({
              ...d,
              status: event.isError ? "failed" : "done",
            }));
            break;
          case "usage":
            onUsage(event.provider, event.details);
            break;
          case "error":
            update(replyId, (m) => ({ ...m, error: event.message }));
            break;
          case "done":
            update(replyId, (m) => ({
              ...m,
              meta: t("chat.meta", {
                seconds: (event.durationMs / 1000).toFixed(1),
                turns: String(event.turns),
              }),
              error: event.isError
                ? (m.error ?? t("chat.responseInterrupted"))
                : m.error,
            }));
            break;
        }
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        update(replyId, (m) => ({
          ...m,
          error: err instanceof Error ? err.message : t("chat.sendFailed"),
        }));
      }
    } finally {
      update(replyId, (m) => ({
        ...m,
        streaming: false,
        error:
          abort.signal.aborted && !m.meta ? t("chat.interrupted") : m.error,
        delegations: m.delegations.map((d) =>
          d.status === "running" ? { ...d, status: "failed" } : d,
        ),
      }));
      setStreaming(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  function newConversation() {
    setSessionId(undefined);
    setSessionProvider(undefined);
    setMessages([]);
    setFocus(null);
  }

  /** A conversation belongs to one provider: a model of another one starts a new conversation. */
  function chooseModel(value: string) {
    const provider = connections.find((c) =>
      c.models.some((m) => m.value === value),
    )?.provider;
    if (sessionProvider && provider && provider !== sessionProvider)
      newConversation();
    setModel(value);
  }

  /** A conversation belongs to one agent (or none): switching starts a new one. */
  function switchAgent(key: string) {
    setAgentKey(key);
    newConversation();
  }

  return (
    <section
      className={dragging ? "card chat dragging" : "card chat"}
      aria-label={t("chat.title")}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="chat-head">
        <h2>{t("chat.title")}</h2>
        {workspace && workspace.entries.length > 0 && (
          <small
            className="entries"
            title={workspace.entries.map((e) => e.name).join(", ")}
          >
            {workspace.entries
              .slice(0, 6)
              .map((e) => (e.dir ? `${e.name}/` : e.name))
              .join(", ")}
            {workspace.entries.length > 6 && ", …"}
          </small>
        )}
        {sessionId && (
          <button
            type="button"
            className="link"
            disabled={streaming}
            onClick={newConversation}
          >
            {t("chat.newConversation")}
          </button>
        )}
      </div>

      {workspaceError && (
        <p className="error" role="alert">
          {workspaceError}
        </p>
      )}

      {workspace && (
        <>
          <AgentTrail
            delegations={delegations}
            focus={focused ? focus : null}
            onFocus={setFocus}
          />
          {focused && (
            <div className="messages" aria-live="polite">
              <DelegationView
                delegation={focused}
                root={workspace.path}
                onBack={() => setFocus(null)}
              />
            </div>
          )}
          <div
            className="messages"
            aria-live="polite"
            ref={listRef}
            onScroll={onScroll}
            hidden={Boolean(focused)}
          >
            {messages.length === 0 && (
              <div className="chat-empty hint">
                {agent ? (
                  <>
                    <p>
                      <strong>{agent.key}</strong>: {agent.description}
                    </p>
                    <p>
                      {t("chat.agentAccess", {
                        access: t(FILE_ACCESS_KEY[agent.effective.files]),
                      })}{" "}
                      <code>{workspace.path}</code>
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      {t("chat.directIntro")} <code>{workspace.path}</code>
                    </p>
                    <p>
                      {agents.length > 0
                        ? t("chat.canDelegate", {
                            agents: agents.map((a) => a.key).join(", "),
                          })
                        : t("chat.noAgent")}
                    </p>
                  </>
                )}
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`message ${m.role}`}>
                <ToolList tools={m.tools} root={workspace.path} />
                {m.delegations.map((d) => (
                  <DelegationCard
                    key={d.id}
                    delegation={d}
                    onOpen={() => setFocus(d.id)}
                  />
                ))}
                {m.attachments && m.attachments.length > 0 && (
                  <AttachmentList attachments={m.attachments} />
                )}
                {m.text && <div className="bubble">{m.text}</div>}
                {m.streaming && !m.text && (
                  <div className="bubble typing">{t("chat.thinking")}</div>
                )}
                {m.error && (
                  <p className="error" role="alert">
                    {m.error}
                  </p>
                )}
                {m.meta && <small>{m.meta}</small>}
              </div>
            ))}
          </div>

          <form className="composer" onSubmit={onSubmit}>
            {attachments.length > 0 && (
              <AttachmentList
                attachments={attachments}
                onRemove={(i) =>
                  setAttachments((list) => list.filter((_, j) => j !== i))
                }
              />
            )}
            {attachError && (
              <p className="error" role="alert">
                {attachError}
              </p>
            )}
            <div className="composer-box">
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                accept={ACCEPT}
                onChange={(e) => {
                  if (e.target.files) void attach(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                className="icon attach"
                aria-label={t("chat.attach")}
                title={t("chat.attach")}
                disabled={streaming || attachments.length >= MAX_ATTACHMENTS}
                onClick={() => fileRef.current?.click()}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  aria-hidden="true"
                >
                  <path
                    d="M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <textarea
                ref={inputRef}
                rows={1}
                autoFocus
                aria-label={t("chat.messageLabel")}
                placeholder={t("chat.placeholder")}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
              />
              {streaming ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => abortRef.current?.abort()}
                >
                  {t("chat.stop")}
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim() && attachments.length === 0}
                >
                  {t("chat.send")}
                </button>
              )}
            </div>
            <div className="row">
              <select
                aria-label={t("chat.agentLabel")}
                value={agentKey}
                disabled={streaming}
                onChange={(e) => switchAgent(e.target.value)}
              >
                <option value="">{t("chat.directOption")}</option>
                {agents.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.key} · {t(FILE_ACCESS_KEY[a.effective.files])}
                  </option>
                ))}
              </select>
              <select
                aria-label={t("chat.modelLabel")}
                value={model}
                disabled={streaming}
                onChange={(e) => chooseModel(e.target.value)}
              >
                <option value="">
                  {agent?.model
                    ? t("chat.agentModel", { model: agent.model })
                    : t("chat.defaultModel")}
                </option>
                {connections.map((c) => (
                  <optgroup key={c.provider} label={c.label}>
                    {c.models.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.displayName}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <small>{t("chat.hint")}</small>
            </div>
          </form>
        </>
      )}
    </section>
  );
}

function AttachmentList({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove?: (index: number) => void;
}) {
  const { t } = useI18n();
  return (
    <ul className="attachments">
      {attachments.map((a, i) => (
        <li
          key={i}
          className={isImage(a) ? "attachment image" : "attachment"}
          title={a.name}
        >
          {isImage(a) ? (
            <img src={previewUrl(a)} alt={a.name} />
          ) : (
            <>
              <span className="ext">
                {a.mediaType === "application/pdf" ? "PDF" : "TXT"}
              </span>
              <span className="name">{a.name}</span>
            </>
          )}
          {onRemove && (
            <button
              type="button"
              className="remove"
              aria-label={t("chat.removeAttachment", { name: a.name })}
              onClick={() => onRemove(i)}
            >
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
