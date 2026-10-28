import {
  forwardRef,
  useEffect,
  useImperativeHandle,
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
import { isActive, runsApi, type Run, type RunStatus } from "../runs/api";
import { reasonText } from "../runs/reason";
import { STATUS_KEY, type ActiveRunsState } from "../runs/useActiveRuns";
import {
  chatApi,
  type HistoryMessage,
  type SessionSummary,
  type Workspace,
} from "./api";
import { MessageText } from "./MessageText";
import { ModelMenu } from "./ModelMenu";
import { SessionList } from "./Sessions";
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
  /** The user's runs, kept live: where the turn being followed stands. */
  runs: ActiveRunsState;
  /** Chat run to show, from a link: its conversation, or the turn alone while it has none. */
  open: Run | null;
  /** Past conversations shown in place of the chat: the workspace bar owns the switch. */
  historyOpen: boolean;
  onHistoryOpen: (open: boolean) => void;
  /** Agent the chat delegates to, '' to chat with the model; picked from the workspace bar. */
  agent: string;
  /** Called when the chat switches agent, so the bar's icon follows. */
  onAgentChange: (key: string) => void;
}

/** What the workspace bar can ask of the chat. */
export interface ChatPanelHandle {
  /** Starts an empty conversation; the current one stays in the history. */
  newConversation: () => void;
  /** Switches the agent the next message goes to. */
  selectAgent: (key: string) => void;
}

/**
 * Chat inside one folder, with an agent or straight with the model, which may
 * then delegate to the project's agents. Each turn runs in the background:
 * switching conversation or leaving only stops following it, and opening the
 * conversation again picks it up. Remount it (key) to switch folders.
 */
export const ChatPanel = forwardRef<ChatPanelHandle, Props>(function ChatPanel(
  {
    projectId,
    path,
    agents,
    connections,
    onUsage,
    runs,
    open,
    historyOpen,
    onHistoryOpen,
    agent: agentKey,
    onAgentChange,
  },
  ref,
) {
  const { t, language } = useI18n();
  const { markSeen } = runs;
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  /** '' leaves the effort to the model. */
  const [effort, setEffort] = useState("");
  const efforts = effortsOf(model);
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
  /** Past conversations shown in place of the chat. */
  const showSessions = historyOpen;
  const [streaming, setStreaming] = useState(false);
  /** Run of the turn being followed. */
  const [turnRun, setTurnRun] = useState<number | null>(null);
  const turn = turnRun !== null ? runs.find(turnRun) : undefined;
  /** Stops following the current turn; the turn itself goes on. */
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
    try {
      const { runId } = await chatApi.send({
        projectId,
        agent: agent?.key,
        message: text,
        attachments: files.length ? files : undefined,
        sessionId,
        model: model || undefined,
        effort: efforts.includes(effort) ? effort : undefined,
      });
      void followTurn(runId, replyId);
    } catch (err) {
      update(replyId, (m) => ({
        ...m,
        streaming: false,
        error: err instanceof Error ? err.message : t("chat.sendFailed"),
      }));
      setStreaming(false);
    }
  }

  function stopFollowing() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setTurnRun(null);
  }

  /** Shows the turn's events from its first one, into the reply `replyId`. */
  async function followTurn(runId: number, replyId: number) {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setTurnRun(runId);
    setStreaming(true);
    let ended: RunStatus | null = null;
    try {
      for await (const event of runsApi.follow(runId, abort.signal)) {
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
          case "finished":
            ended = event.status;
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
    }
    // Stopped following (another conversation, or leaving): the turn goes on.
    if (abort.signal.aborted) return;
    update(replyId, (m) => ({
      ...m,
      streaming: false,
      error:
        ended === "aborted" && !m.meta
          ? t("chat.interrupted")
          : ended === "interrupted"
            ? t("run.interruptedByBackend")
            : m.error,
      delegations: m.delegations.map((d) =>
        d.status === "running" ? { ...d, status: "failed" } : d,
      ),
    }));
    abortRef.current = null;
    setStreaming(false);
    setTurnRun(null);
    if (!document.hidden) markSeen(runId);
  }

  /** Shows a turn still going, after the finished ones, and follows it. */
  function showTurn(runId: number, input: string) {
    const userId = nextId.current++;
    const replyId = nextId.current++;
    setMessages((list) => [
      ...list,
      { id: userId, role: "user", text: input, tools: [], delegations: [] },
      {
        id: replyId,
        role: "assistant",
        text: "",
        tools: [],
        delegations: [],
        streaming: true,
      },
    ]);
    void followTurn(runId, replyId);
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
    stopFollowing();
    setSessionId(undefined);
    setSessionProvider(undefined);
    setMessages([]);
    setFocus(null);
  }

  // The workspace bar starts a new conversation, and doesn't reopen the history.
  useImperativeHandle(ref, () => ({
    newConversation() {
      newConversation();
      onHistoryOpen(false);
    },
    selectAgent(key: string) {
      switchAgent(key);
      onHistoryOpen(false);
    },
  }));

  /**
   * A conversation as the chat's own: shown, with its turn in progress
   * followed, and continued by the next message. One still without an id is
   * only its first turn.
   */
  async function openSession(
    session: Pick<SessionSummary, "sessionId" | "runId">,
  ) {
    if (session.sessionId === null) {
      const run = await runsApi.get(session.runId!);
      stopFollowing();
      setMessages([]);
      setSessionId(run.sessionId ?? undefined);
      setSessionProvider(run.provider ?? undefined);
      restoreModel(run.model, run.effort);
      if (isActive(run.status)) {
        showTurn(run.id, run.input);
      } else {
        // Ended before the provider saved anything: only the run knows of it.
        setMessages([
          {
            id: nextId.current++,
            role: "user",
            text: run.input,
            tools: [],
            delegations: [],
          },
          {
            id: nextId.current++,
            role: "assistant",
            text: "",
            tools: [],
            delegations: [],
            error: run.error ?? t(STATUS_KEY[run.status]),
          },
        ]);
      }
    } else {
      const history = await chatApi.history(projectId, session.sessionId);
      stopFollowing();
      setMessages(history.messages.map(fromHistory));
      setSessionId(history.sessionId);
      setSessionProvider(history.provider);
      restoreModel(history.model, history.effort);
      const last = history.lastRun;
      if (last && isActive(last.status)) showTurn(last.runId, last.input);
      else if (last) markSeen(last.runId);
    }
    setFocus(null);
    onHistoryOpen(false);
    stickRef.current = true;
  }

  // A link to a chat run opens its conversation.
  useEffect(() => {
    if (!open || !workspace) return;
    void openSession({ sessionId: open.sessionId, runId: open.id });
    // Only when the link changes, once the folder is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, Boolean(workspace)]);

  function fromHistory(m: HistoryMessage): Message {
    return {
      id: nextId.current++,
      role: m.role,
      text: m.text,
      attachments: m.attachments.map((a) => ({
        name: a.name,
        mediaType: a.mediaType as Attachment["mediaType"],
        data: "",
      })),
      tools: m.tools,
      delegations: m.delegations.map(({ isError, ...d }) => ({
        ...d,
        status: isError ? "failed" : "done",
      })),
    };
  }

  function providerLabel(provider: string) {
    return connections.find((c) => c.provider === provider)?.label ?? provider;
  }

  /** Effort levels `value` accepts; none for the default model, whose own aren't known. */
  function effortsOf(value: string) {
    return (
      connections.flatMap((c) => c.models).find((m) => m.value === value)
        ?.efforts ?? []
    );
  }

  /** The model and effort a reopened conversation last used, if still offered; else the defaults. */
  function restoreModel(value: string | null, level: string | null) {
    const offered = connections.some((c) =>
      c.models.some((m) => m.value === value),
    );
    setModel(value && offered ? value : "");
    setEffort(value && level && effortsOf(value).includes(level) ? level : "");
  }

  /** A conversation belongs to one provider: a model of another one starts a new conversation. */
  function chooseModel(value: string) {
    if (value === model) return;
    const provider = connections.find((c) =>
      c.models.some((m) => m.value === value),
    )?.provider;
    if (sessionProvider && provider && provider !== sessionProvider)
      newConversation();
    setModel(value);
    // Kept when the new model accepts it too.
    if (!effortsOf(value).includes(effort)) setEffort("");
  }

  /** A conversation belongs to one agent (or none): switching starts a new one. */
  function switchAgent(key: string) {
    if (key === agentKey) return;
    onAgentChange(key);
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
      {workspaceError && (
        <p className="error" role="alert">
          {workspaceError}
        </p>
      )}

      {workspace && (
        <>
          {showSessions && (
            <div className="messages">
              <SessionList
                projectId={projectId}
                current={sessionId}
                providerLabel={providerLabel}
                onOpen={openSession}
                onBack={() => onHistoryOpen(false)}
              />
            </div>
          )}
          <AgentTrail
            delegations={showSessions ? [] : delegations}
            focus={focused ? focus : null}
            onFocus={setFocus}
          />
          {focused && !showSessions && (
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
            hidden={Boolean(focused) || showSessions}
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
                {m.text &&
                  (m.role === "assistant" ? (
                    <MessageText text={m.text} />
                  ) : (
                    <div className="bubble">{m.text}</div>
                  ))}
                {m.streaming && !m.text && (
                  <div className="bubble typing">
                    {turn?.status === "queued"
                      ? reasonText(turn.reason, t, language)
                      : t("chat.thinking")}
                  </div>
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
                  disabled={turnRun === null}
                  onClick={() => {
                    if (turnRun !== null) void runsApi.abort(turnRun);
                  }}
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
              <ModelMenu
                models={connections.flatMap((c) =>
                  c.models.map((m) => ({
                    value: m.value,
                    label: m.displayName,
                    group: c.label,
                  })),
                )}
                defaultLabel={
                  agent?.model
                    ? t("chat.agentModel", { model: agent.model })
                    : t("chat.defaultModel")
                }
                model={model}
                efforts={efforts}
                effort={effort}
                disabled={streaming}
                onModel={chooseModel}
                onEffort={setEffort}
              />
              <small>{t("chat.hint")}</small>
            </div>
          </form>
        </>
      )}
    </section>
  );
});

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
          className={isImage(a) && a.data ? "attachment image" : "attachment"}
          title={a.name}
        >
          {/* A past conversation's attachments come without their content. */}
          {isImage(a) && a.data ? (
            <img src={previewUrl(a)} alt={a.name} />
          ) : (
            <>
              <span className="ext">
                {isImage(a)
                  ? "IMG"
                  : a.mediaType === "application/pdf"
                    ? "PDF"
                    : "TXT"}
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
