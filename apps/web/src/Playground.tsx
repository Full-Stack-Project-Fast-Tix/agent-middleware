import { Fragment, useEffect, useRef } from "react";
import { api } from "./api";
import { MessageContent } from "./MessageContent";
import type { Agent } from "./types";
import { ReflectionList } from "./Reflections";
import { Trajectory } from "./Trajectory";
import { Workspace } from "./Workspace";
import { AgentSafetyDetails } from "./Admin";
import { emptyForm, isActiveRun, type PlaygroundState } from "./usePlayground";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

/** The legacy single-agent chat: pick or create an agent, then work with it. */
export function Playground({ state }: { state: PlaygroundState }) {
  const {
    agents, selectedId, setSelectedId, selected, messages, system,
    showCreate, setShowCreate, showSettings, setShowSettings,
    form, setForm, prompt, setPrompt,
    activeRun, setActiveRun, liveRun, steps, traceRecords, traceRedactions,
    busy, error, setError, resolvingApprovalId,
    adminOverview, showSafetyPanel, setShowSafetyPanel, showWorkspace, setShowWorkspace,
    safetyMemoryUpdated, openSafetyPanel,
    createAgent, saveAgent, toggleAgent, deleteAgent, resolveApproval, sendMessage,
  } = state;
  const messageEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const activityForActiveRun = () =>
    activeRun === null ? null : (
      <>
        <Trajectory
          key={activeRun.id}
          steps={steps}
          live={liveRun}
          records={traceRecords}
          status={activeRun.status}
          findings={activeRun.findings ?? []}
          redactions={traceRedactions}
          pendingApproval={activeRun.pendingApproval ?? null}
          approvalBusy={resolvingApprovalId === activeRun.pendingApproval?.id}
          onApprovalDecision={(decision) => void resolveApproval(decision)}
        />
        {safetyMemoryUpdated && (
          <div className="safety-memory-updated">Safety memory updated</div>
        )}
      </>
    );

  return (
    <div className="playground-page">
      <aside className="agent-pane" aria-label="Your agents">
        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          Create agent
        </button>

        <div className="sidebar-label">
          <span>Your agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <div className="playground-main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set MODEL_PROVIDER=openai and OPENAI_API_KEY in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
                <ReflectionList reflections={selected.reflections ?? []} />
              </div>
              <div className="header-actions">
                <div className="agent-management-actions">
                  <button
                    className="button button-ghost"
                    onClick={() => setShowSettings((value) => !value)}
                    disabled={busy || selected.status === "busy"}
                  >
                    Settings
                  </button>
                  <button
                    className="button button-ghost"
                    onClick={toggleAgent}
                    disabled={busy}
                  >
                    {selected.status === "stopped" ? "Start" : "Stop"}
                  </button>
                  <button
                    className="button button-danger"
                    onClick={deleteAgent}
                    disabled={busy || selected.status === "busy"}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section
              className={
                "playground " +
                (showSafetyPanel || showWorkspace ? "playground-with-safety" : "")
              }
            >
              <div className="chat-column">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="topbar-actions">
                  <div className="session-info">
                    <span className="pulse" />
                    {selected.codexThreadId ? "Session connected" : "New session"}
                  </div>
                  <button
                    className="safety-toggle"
                    onClick={() => setShowWorkspace((value) => !value)}
                  >
                    Workspace
                  </button>
                  <button className="safety-toggle" onClick={openSafetyPanel}>
                    Safety
                  </button>
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <Fragment key={message.id}>
                      {message.role === "assistant" && message.runId === activeRun?.id &&
                        activityForActiveRun()}
                      <article className={"message message-" + message.role}>
                        <div className="message-meta">
                          <strong>{message.role === "user" ? "You" : selected.name}</strong>
                          <span>{formatTime(message.createdAt)}</span>
                        </div>
                        <MessageContent
                          content={message.content}
                          rich={message.role === "assistant"}
                        />
                      </article>
                    </Fragment>
                  ))
                )}
                {activeRun !== null &&
                  !messages.some(
                    (message) => message.role === "assistant" && message.runId === activeRun.id,
                  ) &&
                  activityForActiveRun()}

                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    isActiveRun(activeRun)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      isActiveRun(activeRun)
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
              </div>
              {showWorkspace && (
                <Workspace
                  agentId={selected.id}
                  reflections={selected.reflections ?? []}
                  onClose={() => setShowWorkspace(false)}
                />
              )}
              {showSafetyPanel && (
                <aside className="chat-safety-panel" aria-label={`${selected.name} safety`}>
                  <header className="chat-safety-header">
                    <div><span className="eyebrow">Live safety</span><strong>{selected.name}</strong></div>
                    <button onClick={() => setShowSafetyPanel(false)} aria-label="Close safety panel">×</button>
                  </header>
                  <div className="chat-safety-scroll">
                    {adminOverview === null ? <p className="muted-copy">Loading safety evidence…</p> : (
                      <AgentSafetyDetails overview={adminOverview} agent={selected} onViewRun={(agentId, runId) => {
                        setShowSafetyPanel(false);
                        setSelectedId(agentId);
                        void api.run(runId).then(({ run }) => setActiveRun(run));
                      }} />
                    )}
                  </div>
                </aside>
              )}
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </div>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
