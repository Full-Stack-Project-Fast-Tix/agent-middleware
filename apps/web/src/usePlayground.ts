import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { parseTrace, toSteps, type TraceRecord, type TraceStep } from "./trace";
import type { AdminOverview, Agent, AgentRun, Message, SystemInfo } from "./types";

const ACTIVE_RUN_STATUSES: AgentRun["status"][] = ["queued", "running", "waiting_approval"];

export function isActiveRun(run: AgentRun | null): boolean {
  return run !== null && ACTIVE_RUN_STATUSES.includes(run.status);
}

export const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

export type PlaygroundState = ReturnType<typeof usePlayground>;

/**
 * The legacy single-agent Playground's state and its run polling. It lives above
 * the routes, so a run keeps being followed while you look at another page, and
 * the Safety page can share the selected agent.
 */
export function usePlayground() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [steps, setSteps] = useState<TraceStep[]>([]);
  const [traceRecords, setTraceRecords] = useState<TraceRecord[]>([]);
  const [traceRedactions, setTraceRedactions] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(null);
  const [adminAgentId, setAdminAgentId] = useState<string | null>(null);
  const [showSafetyPanel, setShowSafetyPanel] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const safetyPanelOpenRef = useRef(false);
  const tracedRunId = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  safetyPanelOpenRef.current = showSafetyPanel;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const liveRun = isActiveRun(activeRun);
  const safetyMemoryUpdated =
    activeRun !== null &&
    (selected?.reflections ?? []).some((reflection) => reflection.sightings.includes(activeRun.id));

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  const openAdmin = useCallback(() => {
    setAdminAgentId(null);
    setError(null);
    void api.adminOverview()
      .then(setAdminOverview)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const openSafetyPanel = () => {
    setShowSafetyPanel(true);
    setError(null);
    void api.adminOverview()
      .then(setAdminOverview)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  useEffect(() => {
    if (!showSafetyPanel) return;
    const refresh = () => void api.adminOverview().then(setAdminOverview).catch(() => undefined);
    refresh();
    if (!liveRun) return;
    const timer = window.setInterval(refresh, 900);
    return () => window.clearInterval(timer);
  }, [liveRun, showSafetyPanel]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setActiveRun(null);
    setSteps([]);
    setTraceRecords([]);
    setShowSettings(false);
    setShowSafetyPanel(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (isActiveRun(latest)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  // The trace file is appended as the run happens, so reading it on every poll
  // makes steps appear one by one rather than all at the end.
  const refreshTrace = async (runId: string, agentId: string) => {
    const trace = await api.trace(runId);
    if (trace === null) return;
    if (selectedIdRef.current !== agentId) return;
    const records = parseTrace(trace.text);
    setTraceRecords(records);
    setSteps(toSteps(records));
    setTraceRedactions(trace.redactions);
  };

  // A finished run is never polled, so its trace is read once when it opens.
  // Without this, the activity panel says a finished run took no action at all.
  const finishedRun = activeRun !== null && !isActiveRun(activeRun) ? activeRun : null;
  const finishedRunId = finishedRun?.id ?? null;
  const finishedRunAgentId = finishedRun?.agentId ?? null;
  useEffect(() => {
    if (finishedRunId === null || finishedRunAgentId === null) return;
    if (tracedRunId.current !== finishedRunId) {
      setSteps([]);
      setTraceRecords([]);
      setTraceRedactions(0);
    }
    tracedRunId.current = finishedRunId;
    void refreshTrace(finishedRunId, finishedRunAgentId).catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [finishedRunId, finishedRunAgentId]);

  const resolveApproval = async (decision: "approve" | "deny") => {
    const approval = activeRun?.pendingApproval;
    if (activeRun === null || approval === null || approval === undefined) return;
    setResolvingApprovalId(approval.id);
    setError(null);
    try {
      const result = await api.resolveApproval(activeRun.id, approval.id, decision);
      if (selectedIdRef.current === activeRun.agentId) setActiveRun(result.run);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      const latest = await api.run(activeRun.id).catch(() => null);
      if (latest !== null && selectedIdRef.current === activeRun.agentId) {
        setActiveRun(latest.run);
      }
    } finally {
      setResolvingApprovalId(null);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        await refreshTrace(runId, agentId);
        if (!isActiveRun(result.run)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          if (safetyPanelOpenRef.current) {
            void api.adminOverview().then(setAdminOverview).catch(() => undefined);
          }
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
    setSteps([]);
    setTraceRecords([]);
      await refreshAgents();
    }
  };

  return {
    agents, selectedId, setSelectedId, selected, messages, system,
    showCreate, setShowCreate, showSettings, setShowSettings,
    form, setForm, prompt, setPrompt,
    activeRun, setActiveRun, liveRun, steps, traceRecords, traceRedactions,
    busy, error, setError, resolvingApprovalId,
    adminOverview, adminAgentId, setAdminAgentId,
    showSafetyPanel, setShowSafetyPanel, showWorkspace, setShowWorkspace,
    safetyMemoryUpdated,
    bootstrap, openAdmin, openSafetyPanel,
    createAgent, saveAgent, toggleAgent, deleteAgent, resolveApproval, sendMessage,
  };
}
