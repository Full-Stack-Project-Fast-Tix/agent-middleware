// What this Agent has been stopped for before. This is Agent-level state, so it
// lives by the Agent header rather than inside an individual conversation.
//
// A reflection is stored as values, never as prose, so this renders fields
// rather than sentences. That is not a display choice — nothing the model wrote
// is kept, so there is no sentence to show.

import type { Reflection } from "./types";
import { ForeignInline } from "./ui";

/** Plain-language description of what a reflection watches. */
function subjectOf(reflection: Reflection): { label: string; value: string | null } {
  const destination = reflection.facts.destination;
  if (destination !== undefined) {
    return { label: "Watch destination", value: destination };
  }

  const source = reflection.facts.source;
  if (source !== undefined) {
    return { label: "Watch file", value: source };
  }

  return { label: reflection.code, value: null };
}

const WHEN: Record<string, string> = {
  "sensitive-read": "After a secret is read",
  "encoded-blob": "When the payload is encoded",
  "untrusted-source-read": "Whenever it is read",
  none: "Always",
};

export function ReflectionList({ reflections }: { reflections: Reflection[] }) {
  return (
    <details className="safety-memory">
      <summary>
        Safety memory <span className="tabular">{reflections.length}</span>
      </summary>

      {reflections.length === 0 ? (
        <p className="meta">No safety lessons yet.</p>
      ) : (
        <ul className="reflection-items">
          {reflections.map((reflection) => {
            const subject = subjectOf(reflection);
            const when = WHEN[reflection.facts.precondition ?? "none"] ?? "Always";
            const seen = reflection.sightings.length;
            // Mirrors tierOf on the server. An absent list predates thread
            // tracking and counts as recurring, so an upgrade never demotes.
            const conversations = reflection.threads?.length;
            const recurring = conversations === undefined || conversations >= 2;
            const needsAttention = conversations !== undefined && conversations >= 3;

            return (
              <li className="reflection-item" key={`${reflection.code}:${subject.value}:${when}`}>
                <div className="cluster">
                  <span>{subject.label}</span>
                  {subject.value !== null && <ForeignInline>{subject.value}</ForeignInline>}
                  {recurring && (
                    <span className="badge" title="Seen in more than one conversation">Recurring</span>
                  )}
                  {needsAttention && (
                    <span
                      className="badge badge-held"
                      title="This Agent has been stopped here in three separate conversations. Steering it again is unlikely to help."
                    >
                      Needs a look
                    </span>
                  )}
                </div>
                <div className="cluster meta">
                  <span>{when}</span>
                  <span>Seen in {seen} run{seen === 1 ? "" : "s"}</span>
                  {conversations !== undefined && conversations > 1 && (
                    <span>Across {conversations} conversations</span>
                  )}
                  {reflection.facts.channel !== undefined && <span>Over {reflection.facts.channel}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="meta">
        Stored as guard settings, not as text in the prompt, so they cost no tokens and the
        agent is never asked to agree to them.
      </p>
    </details>
  );
}
