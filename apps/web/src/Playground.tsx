import { Fragment, useEffect, useRef } from "react";
import { api } from "./api";
import { MessageContent } from "./MessageContent";
import { ReflectionList } from "./Reflections";
import { Trajectory } from "./Trajectory";
import { Workspace } from "./Workspace";
import { AgentSafetyDetails } from "./Admin";
import { Button, EmptyState, ErrorState, Foreign, Loading, Select, StatusBadge } from "./ui";
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

function CreateAgentDialog({ state }: { state: PlaygroundState }) {
  const { form, setForm, busy, error, createAgent, setShowCreate } = state;
  const dialog = useRef<HTMLDialogElement>(null);

  // A native modal gives us the focus trap, Escape and the inert page for free.
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      className="dialog"
      ref={dialog}
      aria-labelledby="create-agent-title"
      onClose={() => setShowCreate(false)}
      onMouseDown={(event) => {
        if (event.target === dialog.current) setShowCreate(false);
      }}
    >
      <form className="form-stack" onSubmit={(event) => void createAgent(event)}>
        <div className="dialog-heading">
          <h2 id="create-agent-title">Create an agent</h2>
          <p className="meta">Each agent gets a persistent folder and a resumable Codex session.</p>
        </div>
        {error && <div className="state-error" role="alert">{error}</div>}
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
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            maxLength={500}
          />
        </label>
        <label>
          Instructions
          <textarea
            value={form.instructions}
            onChange={(event) => setForm({ ...form, instructions: event.target.value })}
            rows={6}
            maxLength={10_000}
          />
        </label>
        <div className="form-actions">
          <Button type="submit" variant="primary" busy={busy}>Create agent</Button>
          <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
        </div>
      </form>
    </dialog>
  );
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
    saveAgent, toggleAgent, deleteAgent, resolveApproval, sendMessage,
  } = state;
  const messageEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun, steps.length]);

  const openCreate = () => {
    setForm(emptyForm);
    setShowCreate(true);
  };

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
        {safetyMemoryUpdated && <p className="meta">Safety memory updated</p>}
      </>
    );

  const composerClosed = selected?.status === "stopped" || selected?.status === "busy" || isActiveRun(activeRun);

  return (
    <div className="playground-page">
      <aside className="agent-pane" aria-label="Your agents">
        <div className="agent-pane-head">
          <h2>Agents <span className="meta tabular">{agents.length}</span></h2>
          <Button variant="primary" onClick={openCreate}>Create agent</Button>
        </div>

        {agents.length === 0 ? (
          <p className="meta agent-pane-empty">No agents yet.</p>
        ) : (
          <>
            <div className="agent-select">
              <Select
                label="Agent"
                value={selectedId ?? ""}
                onChange={setSelectedId}
                options={agents.map((agent) => ({
                  value: agent.id,
                  label: agent.name,
                  hint: agent.status === "ready" ? undefined : agent.status,
                }))}
              />
            </div>
            <ul className="agent-list">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    className="agent-row"
                    aria-current={agent.id === selectedId ? "true" : undefined}
                    onClick={() => setSelectedId(agent.id)}
                  >
                    <span className="agent-row-name">{agent.name}</span>
                    <span className="agent-row-note">
                      {agent.status === "ready" ? agent.description || "Coding agent" : <StatusBadge status={agent.status} live={agent.status === "busy"} />}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <dl className="runtime-facts">
          <div><dt>Runtime</dt><dd>{system?.runtime ?? "Checking"}</dd></div>
          <div><dt>Model</dt><dd>{system === null ? "Checking" : system.arkModel ?? "Not configured"}</dd></div>
          {system?.containerEngine && <div><dt>Container engine</dt><dd>{system.containerEngine}</dd></div>}
        </dl>
      </aside>

      <div className="playground-main">
        {system !== null && (!system.arkConfigured || !system.codexAvailable) && (
          <div className="runtime-notice" role="status">
            <strong>The runtime needs configuring</strong>
            <p>
              {!system.arkConfigured
                ? "Set MODEL_PROVIDER=openai and OPENAI_API_KEY in .env before using the Playground."
                : system.runtimeProvider === "container"
                  ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                  : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
            </p>
          </div>
        )}

        {error && (
          <div className="notice notice-blocked playground-banner" role="alert">
            <span>{error}</span>
            <Button variant="ghost" onClick={() => setError(null)}>Dismiss</Button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div className="agent-header-copy">
                <div className="cluster">
                  <h1>{selected.name}</h1>
                  <StatusBadge status={selected.status} live={selected.status === "busy"} />
                  <span className="meta">{selected.codexThreadId ? "Session connected" : "New session"}</span>
                </div>
                <p className="meta">{selected.description || "A Codex coding agent in an isolated workspace."}</p>
                <ReflectionList reflections={selected.reflections ?? []} />
              </div>
              <div className="agent-header-actions">
                <Button aria-pressed={showWorkspace} onClick={() => setShowWorkspace((value) => !value)}>Workspace</Button>
                <Button aria-pressed={showSafetyPanel} onClick={openSafetyPanel}>Safety</Button>
                <Button
                  aria-expanded={showSettings}
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </Button>
                <Button onClick={() => void toggleAgent()} disabled={busy}>
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </Button>
                <Button variant="danger" onClick={() => void deleteAgent()} disabled={busy || selected.status === "busy"}>
                  Delete
                </Button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel form-stack" onSubmit={(event) => void saveAgent(event)}>
                <h2>Instructions and identity</h2>
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
                      onChange={(event) => setForm({ ...form, description: event.target.value })}
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) => setForm({ ...form, instructions: event.target.value })}
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <p className="meta">Workspace folder: {selected.workspacePath}</p>
                <div className="form-actions">
                  <Button type="submit" variant="primary" busy={busy}>Save changes</Button>
                  <Button variant="ghost" onClick={() => setShowSettings(false)}>Close</Button>
                </div>
              </form>
            )}

            <section className={showSafetyPanel || showWorkspace ? "playground playground-with-side" : "playground"}>
              <div className="chat-column">
                <div className="messages">
                  <div className="messages-inner">
                    {messages.length === 0 && !activeRun ? (
                      <div className="welcome">
                        <h2>What should {selected.name} build?</h2>
                        <p className="meta">
                          The agent can inspect files, write code, run commands and continue the
                          same Codex session across messages.
                        </p>
                        <ul className="starter-list" aria-label="Example requests">
                          {starterPrompts.map((item) => (
                            <li key={item}>
                              <button type="button" className="starter" onClick={() => setPrompt(item)}>{item}</button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      messages.map((message) => (
                        <Fragment key={message.id}>
                          {message.role === "assistant" && message.runId === activeRun?.id &&
                            activityForActiveRun()}
                          {message.role === "user" ? (
                            <article className="message-user">
                              <div className="cluster meta">
                                <strong>You</strong>
                                <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
                              </div>
                              <MessageContent content={message.content} />
                            </article>
                          ) : (
                            <article>
                              <Foreign
                                label={selected.name}
                                note={`${formatTime(message.createdAt)}, not verified by AgentGuard`}
                              >
                                <MessageContent content={message.content} rich />
                              </Foreign>
                            </article>
                          )}
                        </Fragment>
                      ))
                    )}
                    {activeRun !== null &&
                      !messages.some(
                        (message) => message.role === "assistant" && message.runId === activeRun.id,
                      ) &&
                      activityForActiveRun()}

                    {activeRun?.status === "failed" && (
                      <ErrorState title="Run failed" message={activeRun.error ?? "The run stopped without giving a reason. Check Technical details for the trace."} />
                    )}
                    <div ref={messageEnd} />
                  </div>
                </div>

                <div className="composer-wrap">
                <form className="composer" onSubmit={(event) => void sendMessage(event)}>
                  <textarea
                    aria-label="Message to the agent"
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
                        ? "Start this agent to continue"
                        : "Describe what you want the agent to do"
                    }
                    disabled={composerClosed}
                    rows={2}
                  />
                  <div className="composer-footer">
                    <span className="meta">Enter sends, Shift + Enter adds a line. Sandbox: {system?.codexSandboxMode ?? "checking"}</span>
                    <Button type="submit" variant="primary" disabled={!prompt.trim() || composerClosed}>Send</Button>
                  </div>
                </form>
                </div>
              </div>

              {(showWorkspace || showSafetyPanel) && (
                <div className="playground-side">
                  {showWorkspace && (
                    <Workspace
                      agentId={selected.id}
                      reflections={selected.reflections ?? []}
                      onClose={() => setShowWorkspace(false)}
                    />
                  )}
                  {showSafetyPanel && (
                    <aside className="side-panel" aria-label={`${selected.name} safety`}>
                      <header className="side-panel-head">
                        <h2>Safety for {selected.name}</h2>
                        <Button variant="ghost" onClick={() => setShowSafetyPanel(false)}>Close</Button>
                      </header>
                      <div className="side-panel-scroll">
                        {adminOverview === null ? <Loading label="Loading safety records" /> : (
                          <AgentSafetyDetails overview={adminOverview} agent={selected} onViewRun={(agentId, runId) => {
                            setShowSafetyPanel(false);
                            setSelectedId(agentId);
                            void api.run(runId).then(({ run }) => setActiveRun(run));
                          }} />
                        )}
                      </div>
                    </aside>
                  )}
                </div>
              )}
            </section>
          </>
        ) : (
          <div className="no-agent">
            <h1 className="sr-only">Playground</h1>
            <EmptyState title="Create an agent to get started" action={<Button variant="primary" page onClick={openCreate}>Create your first agent</Button>}>
              An agent gets its own workspace. Give Codex a job, then continue the conversation here.
            </EmptyState>
          </div>
        )}
      </div>

      {showCreate && <CreateAgentDialog state={state} />}
    </div>
  );
}
