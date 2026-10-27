import { useEffect, useState } from "react";
import { LOCALES } from "../i18n/messages";
import { useI18n } from "../i18n/useI18n";
import { chatApi, type SessionSummary } from "./api";

/** The project's past conversations; picking one loads it into the chat. */
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
  onOpen: (sessionId: string) => Promise<void>;
  onBack: () => void;
}) {
  const { t, language } = useI18n();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    chatApi
      .sessions(projectId)
      .then(setSessions, (err: unknown) =>
        setError(err instanceof Error ? err.message : t("sessions.loadFailed")),
      );
  }, [projectId, t]);

  async function open(sessionId: string) {
    setError(null);
    setOpening(sessionId);
    try {
      await onOpen(sessionId);
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
            <li key={s.sessionId}>
              <button
                type="button"
                className={
                  s.sessionId === current
                    ? "session-item current"
                    : "session-item"
                }
                aria-current={s.sessionId === current ? "true" : undefined}
                disabled={opening !== null}
                onClick={() => void open(s.sessionId)}
              >
                <span className="session-title">
                  {s.title || t("sessions.untitled")}
                </span>
                <small>
                  {date.format(new Date(s.updatedAt))} ·{" "}
                  {providerLabel(s.provider)}
                  {s.sessionId === current && ` · ${t("sessions.current")}`}
                  {s.sessionId === opening && ` · ${t("sessions.loading")}`}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
