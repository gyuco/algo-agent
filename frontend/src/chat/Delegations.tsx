import type { MessageKey } from "../i18n/messages";
import { useI18n } from "../i18n/useI18n";

export interface Tool {
  name: string;
  target: string | null;
}

export type DelegationStatus = "running" | "done" | "failed";

/** A task the main thread handed to one of the project's agents, and what that agent did. */
export interface Delegation {
  id: string;
  agent: string;
  description: string;
  prompt: string;
  text: string;
  tools: Tool[];
  status: DelegationStatus;
}

const STATUS_KEY: Record<DelegationStatus, MessageKey> = {
  running: "delegation.running",
  done: "delegation.done",
  failed: "delegation.failed",
};

/** Shows a tool target relative to the workspace when it lies inside it. */
function shortTarget(target: string, root: string) {
  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : target;
}

export function ToolList({ tools, root }: { tools: Tool[]; root: string }) {
  if (tools.length === 0) return null;
  return (
    <ul className="tools">
      {tools.map((tool, i) => (
        <li key={i}>
          {tool.name}
          {tool.target && <code>{shortTarget(tool.target, root)}</code>}
        </li>
      ))}
    </ul>
  );
}

function Status({ status }: { status: DelegationStatus }) {
  const { t } = useI18n();
  return (
    <span className={`delegation-status ${status}`}>
      {t(STATUS_KEY[status])}
    </span>
  );
}

/** A delegation inside the main thread's reply: who works on what, and a way in. */
export function DelegationCard({
  delegation,
  onOpen,
}: {
  delegation: Delegation;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const lastLine = delegation.text.trim().split("\n").at(-1);
  return (
    <button
      type="button"
      className={`delegation-card ${delegation.status}`}
      onClick={onOpen}
    >
      <span className="delegation-head">
        <span className="delegation-agent">↳ {delegation.agent}</span>
        <Status status={delegation.status} />
      </span>
      {delegation.description && (
        <span className="delegation-task">{delegation.description}</span>
      )}
      <span className="delegation-foot">
        <span className="delegation-preview">
          {lastLine ||
            (delegation.status === "running" ? t("chat.thinking") : "")}
        </span>
        <span>
          {t("delegation.tools", { count: String(delegation.tools.length) })} ·{" "}
          {t("delegation.open")} →
        </span>
      </span>
    </button>
  );
}

/** Links to the main thread and to every agent it delegated to in this conversation. */
export function AgentTrail({
  delegations,
  focus,
  onFocus,
}: {
  delegations: Delegation[];
  focus: string | null;
  onFocus: (id: string | null) => void;
}) {
  const { t } = useI18n();
  if (delegations.length === 0) return null;
  return (
    <nav className="agent-trail" aria-label={t("delegation.trail")}>
      <button
        type="button"
        className={focus === null ? "trail-item active" : "trail-item"}
        aria-current={focus === null ? "page" : undefined}
        onClick={() => onFocus(null)}
      >
        {t("delegation.main")}
      </button>
      {delegations.map((d) => (
        <button
          key={d.id}
          type="button"
          className={
            focus === d.id
              ? `trail-item active ${d.status}`
              : `trail-item ${d.status}`
          }
          aria-current={focus === d.id ? "page" : undefined}
          title={d.description}
          onClick={() => onFocus(d.id)}
        >
          <span className="trail-dot" aria-hidden="true" />
          {d.agent}
        </button>
      ))}
    </nav>
  );
}

/** One delegated agent's whole run: the task it got, the tools it used and its answer. */
export function DelegationView({
  delegation,
  root,
  onBack,
}: {
  delegation: Delegation;
  root: string;
  onBack: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="delegation-view">
      <div className="delegation-view-head">
        <button type="button" className="link" onClick={onBack}>
          ← {t("delegation.main")}
        </button>
        <span className="delegation-agent">{delegation.agent}</span>
        {delegation.description && (
          <span className="hint">{delegation.description}</span>
        )}
        <Status status={delegation.status} />
      </div>
      <div className="message user delegated-task">
        <small>{t("delegation.task")}</small>
        <div className="bubble">{delegation.prompt}</div>
      </div>
      <div className="message assistant">
        <ToolList tools={delegation.tools} root={root} />
        {delegation.text && <div className="bubble">{delegation.text}</div>}
        {delegation.status === "running" && !delegation.text && (
          <div className="bubble typing">{t("chat.thinking")}</div>
        )}
      </div>
    </div>
  );
}
