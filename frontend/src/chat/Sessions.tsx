import { useEffect, useState } from "react";
import { LOCALES } from "../i18n/messages";
import { useI18n } from "../i18n/useI18n";
import { reasonText } from "../runs/reason";
import { STATUS_KEY } from "../runs/useActiveRuns";
import { chatApi, type SessionSummary } from "./api";

/** The project's conversations, the ones with a turn going marked; picking one loads it into the chat. */
export function SessionList({
  projectId,
  current,
  providerLabel,
  onOpen,
  onBack,
}: {
  projectId: number;
  /** Session open in the chat, marked in the list. */
  current: string | undefined;
  providerLabel: (provider: string) => string;
  onOpen: (session: SessionSummary) => Promise<void>;
  onBack: () => void;
}) {
  const { t, language } = useI18n();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Key of the item being opened. */
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    chatApi
      .sessions(projectId)
      .then(setSessions, (err: unknown) =>
        setError(err instanceof Error ? err.message : t("sessions.loadFailed")),
      );
  }, [projectId, t]);

  async function open(session: SessionSummary) {
    setError(null);
    setOpening(keyOf(session));
    try {
      await onOpen(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sessions.openFailed"));
      setOpening(null);
    }
  }

  const date = new Intl.DateTimeFormat(LOCALES[language], {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div className="sessions">
      <div className="delegation-view-head">
        <button type="button" className="link" onClick={onBack}>
          ← {t("sessions.back")}
        </button>
        <span className="delegation-agent">{t("sessions.title")}</span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!sessions && !error && <p className="hint">{t("sessions.loading")}</p>}
      {sessions?.length === 0 && <p className="hint">{t("sessions.empty")}</p>}
      {sessions && sessions.length > 0 && (
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={keyOf(s)}>
              <button
                type="button"
                className={
                  s.sessionId === current
                    ? "session-item current"
                    : "session-item"
                }
                aria-current={s.sessionId === current ? "true" : undefined}
                disabled={opening !== null}
                onClick={() => void open(s)}
              >
                <span className="session-title">
                  {s.activeRun && (
                    <span className="dot busy" aria-hidden="true" />
                  )}
                  {s.unread && <span className="dot unread" aria-hidden="true" />}
                  {s.title ||
                    t(s.sessionId ? "sessions.untitled" : "sessions.new")}
                </span>
                <small>
                  {date.format(new Date(s.updatedAt))}
                  {s.provider && ` · ${providerLabel(s.provider)}`}
                  {s.activeRun &&
                    ` · ${
                      s.activeRun.status === "queued"
                        ? reasonText(s.activeRun.reason, t, language)
                        : t(STATUS_KEY[s.activeRun.status])
                    }`}
                  {s.unread && ` · ${t("sessions.unread")}`}
                  {s.sessionId !== null &&
                    s.sessionId === current &&
                    ` · ${t("sessions.current")}`}
                  {keyOf(s) === opening && ` · ${t("sessions.loading")}`}
                </small>
              </button>
              {s.missionId != null && (
                <a className="link" href={`#/workspace/${projectId}/mission/${s.missionId}`}>
                  {t('missions.open')}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A conversation's id, or its first turn's while it has none. */
function keyOf(s: SessionSummary) {
  return s.sessionId ?? `run:${s.runId}`;
}
