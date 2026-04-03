import { useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, MessageSquare, Play, Settings, Trash2 } from 'lucide-react';
import {
  addTodo,
  deleteWork,
  fetchModels,
  fetchProviders,
  fetchSessions,
  fetchWorkAgent,
  fetchWorkspaces,
  sendChatMessage,
  startWork,
  toggleTodo,
  type AgentTodo,
  type ChatMessage,
  type ProviderInfo,
  type WorkSession,
  type Workspace,
} from './lib/api';

type Tab = 'graph' | 'settings';

type GraphNodeView = {
  id: string;
  label: string;
  prompt: string;
  x: number;
  y: number;
  status: string;
  dependencies: string[];
};

type TimelineItem = {
  key: string;
  time: string;
  kind: 'chat' | 'event';
  role?: string;
  title?: string;
  content: string;
};

function normalizeTaskStatus(raw?: string): string {
  const value = (raw ?? '').toLowerCase();
  if (value.includes('failed') || value.includes('error')) {
    return 'failed';
  }
  if (value.includes('completed') || value.includes('output') || value.includes('done')) {
    return 'completed';
  }
  if (value.includes('started') || value.includes('stream') || value.includes('tool-call')) {
    return 'running';
  }
  return 'pending';
}

function statusColor(status: string): string {
  switch (status) {
    case 'running':
      return '#2563eb';
    case 'completed':
      return '#059669';
    case 'failed':
      return '#dc2626';
    default:
      return '#94a3b8';
  }
}

function buildGraphLayout(session?: WorkSession): { nodes: GraphNodeView[]; width: number; height: number } {
  if (!session) {
    return { nodes: [], width: 900, height: 520 };
  }

  const baseNodes = session.agentGraph && session.agentGraph.length > 0
    ? session.agentGraph
    : [{ id: session.id, prompt: session.prompt, dependencies: [] }];

  const nodeById = new Map(baseNodes.map((node) => [node.id, node]));
  const levelById = new Map<string, number>();

  const computeLevel = (id: string, trail = new Set<string>()): number => {
    if (levelById.has(id)) {
      return levelById.get(id) ?? 0;
    }
    if (trail.has(id)) {
      return 0;
    }
    trail.add(id);
    const node = nodeById.get(id);
    if (!node || node.dependencies.length === 0) {
      levelById.set(id, 0);
      trail.delete(id);
      return 0;
    }
    const level = Math.max(...node.dependencies.map((dep) => computeLevel(dep, trail) + 1));
    levelById.set(id, level);
    trail.delete(id);
    return level;
  };

  for (const node of baseNodes) {
    computeLevel(node.id);
  }

  const levelGroups = new Map<number, typeof baseNodes>();
  for (const node of baseNodes) {
    const level = levelById.get(node.id) ?? 0;
    const group = levelGroups.get(level) ?? [];
    group.push(node);
    levelGroups.set(level, group);
  }

  const levels = [...levelGroups.keys()].sort((a, b) => a - b);
  const maxPerLevel = Math.max(1, ...[...levelGroups.values()].map((group) => group.length));
  const width = Math.max(900, levels.length * 280 + 180);
  const height = Math.max(520, maxPerLevel * 140 + 180);

  const nodes: GraphNodeView[] = [];
  for (const level of levels) {
    const group = levelGroups.get(level) ?? [];
    const stepY = height / (group.length + 1);
    group.forEach((node, index) => {
      const status = normalizeTaskStatus(session.taskStatus[node.id]);
      nodes.push({
        id: node.id,
        label: node.id,
        prompt: node.prompt,
        x: 130 + level * 260,
        y: stepY * (index + 1),
        status,
        dependencies: node.dependencies,
      });
    });
  }

  return { nodes, width, height };
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('graph');

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerStatuses, setProviderStatuses] = useState<Array<{ provider: string; source: string }>>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('');
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});

  const [sessions, setSessions] = useState<WorkSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [todos, setTodos] = useState<AgentTodo[]>([]);

  const [workProvider, setWorkProvider] = useState('');
  const [workModel, setWorkModel] = useState('');
  const [workWorkspaceId, setWorkWorkspaceId] = useState('');
  const [autoApprove, setAutoApprove] = useState(true);

  const [composerText, setComposerText] = useState('');
  const [todoInput, setTodoInput] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId),
    [sessions, selectedSessionId],
  );

  const graphLayout = useMemo(() => buildGraphLayout(selectedSession), [selectedSession]);

  const timelineItems = useMemo<TimelineItem[]>(() => {
    const eventItems: TimelineItem[] = (selectedSession?.events ?? []).slice(-120).map((event, index) => ({
      key: `event-${event.time}-${index}`,
      time: event.time,
      kind: 'event',
      title: event.type,
      content: event.message,
    }));
    const chatItems: TimelineItem[] = chatMessages.map((message, index) => ({
      key: `chat-${message.time}-${index}`,
      time: message.time,
      kind: 'chat',
      role: message.role,
      content: message.content,
    }));

    return [...eventItems, ...chatItems].sort((a, b) => a.time.localeCompare(b.time));
  }, [chatMessages, selectedSession]);

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const [providersState, workspacesState, sessionsState] = await Promise.all([
          fetchProviders(),
          fetchWorkspaces(),
          fetchSessions(),
        ]);

        setProviders(providersState.providers);
        setProviderStatuses(providersState.statuses);
        setWorkspaces(workspacesState.workspaces);
        setActiveWorkspaceId(workspacesState.activeWorkspaceId ?? '');
        setSessions(sessionsState.sessions);

        const initialSession = sessionsState.sessions[0]?.id;
        if (initialSession) {
          setSelectedSessionId(initialSession);
        }

        const connectedProvider = providersState.statuses.find((status) => status.source !== 'none')?.provider || '';
        const defaultProvider = connectedProvider || providersState.defaults.provider || providersState.providers[0]?.id || '';
        const defaultWorkspace = workspacesState.activeWorkspaceId || workspacesState.workspaces[0]?.id || '';

        setWorkProvider(defaultProvider);
        setWorkWorkspaceId(defaultWorkspace);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    };

    void bootstrap();
  }, []);

  useEffect(() => {
    const loadModels = async () => {
      if (!workProvider) {
        return;
      }

      try {
        const response = await fetchModels(workProvider);
        setProviderModels((previous) => ({
          ...previous,
          [workProvider]: response.models,
        }));

        if (!workModel && response.models.length > 0) {
          setWorkModel(response.models[0]);
        }
      } catch {
        setProviderModels((previous) => ({
          ...previous,
          [workProvider]: [],
        }));
      }
    };

    void loadModels();
  }, [workProvider, workModel]);

  useEffect(() => {
    if (!selectedSessionId) {
      setChatMessages([]);
      setTodos([]);
      return;
    }

    let cancelled = false;

    const refreshSessionState = async () => {
      try {
        const [sessionsState, agentState] = await Promise.all([
          fetchSessions(),
          fetchWorkAgent(selectedSessionId),
        ]);

        if (cancelled) {
          return;
        }

        setSessions(sessionsState.sessions);
        setChatMessages(agentState.messages);
        setTodos(agentState.todos);
      } catch {
        // Keep existing UI state if polling fails temporarily.
      }
    };

    void refreshSessionState();
    const interval = setInterval(() => {
      void refreshSessionState();
    }, 2500);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedSessionId]);

  const handleStartFromComposer = async () => {
    if (!composerText.trim() || !workProvider || !workModel || !workWorkspaceId) {
      return;
    }

    setErrorMessage('');
    try {
      const result = await startWork({
        workspaceId: workWorkspaceId,
        prompt: composerText,
        provider: workProvider,
        model: workModel,
        autoApprove,
      });

      const sessionsState = await fetchSessions();
      setSessions(sessionsState.sessions);
      setSelectedSessionId(result.id);
      setComposerText('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDelete = async () => {
    if (!selectedSessionId) {
      return;
    }

    setErrorMessage('');
    try {
      await deleteWork(selectedSessionId);
      const sessionsState = await fetchSessions();
      setSessions(sessionsState.sessions);
      const nextId = sessionsState.sessions[0]?.id ?? '';
      setSelectedSessionId(nextId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSendChat = async () => {
    if (!selectedSessionId || !composerText.trim()) {
      return;
    }

    const message = composerText;
    setComposerText('');
    setErrorMessage('');

    try {
      const response = await sendChatMessage(selectedSessionId, message);
      setChatMessages(response.messages);
    } catch (error) {
      setComposerText(message);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleAddTodo = async () => {
    if (!selectedSessionId || !todoInput.trim()) {
      return;
    }

    const text = todoInput;
    setTodoInput('');
    setErrorMessage('');

    try {
      const response = await addTodo(selectedSessionId, text);
      setTodos(response.todos);
    } catch (error) {
      setTodoInput(text);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleToggleTodo = async (todo: AgentTodo) => {
    if (!selectedSessionId) {
      return;
    }

    setErrorMessage('');
    try {
      const response = await toggleTodo(selectedSessionId, todo.id, !todo.done);
      setTodos(response.todos);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const currentModels = providerModels[workProvider] ?? [];

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-50 text-slate-900 md:flex-row">
      <aside className="w-full border-b border-slate-200 bg-white md:w-64 md:border-b-0 md:border-r">
        <div className="border-b border-slate-100 px-4 py-3">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-blue-600" />
            <h1 className="text-lg font-bold tracking-tight">Orchestrace</h1>
          </div>
        </div>

        <div className="max-h-56 overflow-y-auto p-3 md:max-h-none md:h-[calc(100vh-65px)] md:overflow-y-auto">
          <button
            className={`mb-1 w-full rounded-md px-3 py-2 text-left text-sm font-medium ${activeTab === 'graph' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}
            onClick={() => setActiveTab('graph')}
          >
            Graph & Flow
          </button>
          <button
            className={`mb-4 w-full rounded-md px-3 py-2 text-left text-sm font-medium ${activeTab === 'settings' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}
            onClick={() => setActiveTab('settings')}
          >
            Settings
          </button>

          <div className="mb-2 border-t border-slate-100 pt-3 text-xs font-bold uppercase tracking-widest text-slate-400">
            Sessions
          </div>

          {sessions.length === 0 && <div className="px-1 text-xs italic text-slate-400">No sessions</div>}

          {sessions.map((session) => (
            <button
              key={session.id}
              className={`mb-1 w-full truncate rounded px-2 py-1.5 text-left text-xs ${selectedSessionId === session.id ? 'bg-blue-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
              onClick={() => setSelectedSessionId(session.id)}
            >
              {session.prompt}
            </button>
          ))}
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        {activeTab === 'graph' ? (
          <div className="flex h-full flex-col lg:flex-row">
            <section className="flex min-w-0 flex-1 flex-col border-b border-slate-200 bg-white lg:border-b-0 lg:border-r">
              <header className="border-b border-slate-200 p-4">
                <div className="text-xs text-slate-500">
                  Center graph is the execution control plane. Use the right panel composer to either start a run or chat with the selected run.
                </div>
              </header>

              <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-4">
                {!selectedSession && (
                  <div className="text-center text-sm italic text-slate-400">Select a session to inspect its flow.</div>
                )}

                {selectedSession && (
                  <div className="space-y-4">
                    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                      <div className="mb-2 flex items-start justify-between gap-2">
                        <h2 className="text-base font-bold text-slate-800">{selectedSession.prompt}</h2>
                        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-mono text-slate-600">
                          {selectedSession.status}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 gap-2 text-xs text-slate-500 md:grid-cols-2">
                        <div>
                          Provider: <span className="font-mono text-slate-700">{selectedSession.provider}</span>
                        </div>
                        <div>
                          Model: <span className="font-mono text-slate-700">{selectedSession.model}</span>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                      <div className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500">Entity Graph</div>
                      <div className="overflow-auto rounded border border-slate-100 bg-slate-50">
                        <svg
                          aria-label="Entity graph"
                          className="block"
                          height={graphLayout.height}
                          role="img"
                          width={graphLayout.width}
                        >
                          {graphLayout.nodes.flatMap((node) => node.dependencies.map((dep) => {
                            const fromNode = graphLayout.nodes.find((candidate) => candidate.id === dep);
                            if (!fromNode) {
                              return null;
                            }
                            return (
                              <line
                                key={`edge-${dep}-${node.id}`}
                                stroke="#94a3b8"
                                strokeWidth={2}
                                x1={fromNode.x + 90}
                                x2={node.x - 90}
                                y1={fromNode.y}
                                y2={node.y}
                              />
                            );
                          }))}

                          {graphLayout.nodes.map((node) => (
                            <g key={node.id}>
                              <rect
                                fill="white"
                                height={72}
                                rx={12}
                                stroke={statusColor(node.status)}
                                strokeWidth={2}
                                width={180}
                                x={node.x - 90}
                                y={node.y - 36}
                              />
                              <text
                                fill="#0f172a"
                                fontSize={12}
                                fontWeight={700}
                                textAnchor="middle"
                                x={node.x}
                                y={node.y - 8}
                              >
                                {node.label}
                              </text>
                              <text
                                fill="#475569"
                                fontSize={10}
                                textAnchor="middle"
                                x={node.x}
                                y={node.y + 10}
                              >
                                {node.status}
                              </text>
                            </g>
                          ))}
                        </svg>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>

            <aside className="flex w-full flex-col bg-white lg:w-[420px]">
              <section className="flex min-h-0 flex-1 flex-col border-b border-slate-200">
                <header className="border-b border-slate-200 bg-white px-4 py-3 text-xs font-bold uppercase tracking-widest text-slate-500">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <MessageSquare className="h-4 w-4" />
                      Chat Timeline
                    </div>
                    <button
                      className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-[10px] text-red-700 disabled:opacity-50"
                      disabled={!selectedSessionId}
                      onClick={() => {
                        void handleDelete();
                      }}
                      type="button"
                    >
                      <Trash2 className="h-3 w-3" />
                      Delete
                    </button>
                  </div>
                </header>
                <div className="min-h-0 flex-1 space-y-2 overflow-auto bg-slate-50 p-4">
                  {timelineItems.length === 0 && (
                    <div className="text-center text-xs italic text-slate-400">No chat/events yet.</div>
                  )}
                  {timelineItems.map((item) => (
                    <div
                      key={item.key}
                      className={`rounded border p-2.5 text-sm ${item.kind === 'event' ? 'border-slate-200 bg-white text-slate-700' : item.role === 'user' ? 'border-blue-100 bg-blue-50 text-blue-900' : 'border-slate-200 bg-white text-slate-700'}`}
                    >
                      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-slate-400">
                        <span>{item.kind === 'event' ? `event:${item.title}` : item.role}</span>
                        <span>{new Date(item.time).toLocaleTimeString([], { hour12: false })}</span>
                      </div>
                      <div className="whitespace-pre-wrap break-words">{item.content}</div>
                    </div>
                  ))}
                </div>
                <div className="border-t border-slate-200 p-3">
                  <div className="mb-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                    <select
                      className="rounded border border-slate-200 px-2 py-1.5 text-sm"
                      value={workWorkspaceId}
                      onChange={(event) => setWorkWorkspaceId(event.target.value)}
                    >
                      <option value="">Workspace</option>
                      {workspaces.map((workspace) => (
                        <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                      ))}
                    </select>
                    <select
                      className="rounded border border-slate-200 px-2 py-1.5 text-sm"
                      value={workProvider}
                      onChange={(event) => {
                        setWorkProvider(event.target.value);
                        setWorkModel('');
                      }}
                    >
                      <option value="">Provider</option>
                      {providers.map((provider) => (
                        <option key={provider.id} value={provider.id}>{provider.id}</option>
                      ))}
                    </select>
                    <select
                      className="rounded border border-slate-200 px-2 py-1.5 text-sm"
                      value={workModel}
                      onChange={(event) => setWorkModel(event.target.value)}
                    >
                      <option value="">Model</option>
                      {currentModels.map((model) => (
                        <option key={model} value={model}>{model}</option>
                      ))}
                    </select>
                    <label className="flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-600">
                      <input
                        checked={autoApprove}
                        className="h-4 w-4"
                        onChange={(event) => setAutoApprove(event.target.checked)}
                        type="checkbox"
                      />
                      Auto-approve
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <textarea
                      className="h-14 flex-1 resize-none rounded border border-slate-200 px-2 py-1.5 text-sm"
                      onChange={(event) => setComposerText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                          if (selectedSessionId) {
                            void handleSendChat();
                          } else {
                            void handleStartFromComposer();
                          }
                        }
                      }}
                      placeholder={selectedSessionId ? 'Chat with selected run, or use Run to start a new run from this text...' : 'Describe task and click Run...'}
                      value={composerText}
                    />
                    <div className="flex flex-col gap-2">
                      <button
                        className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                        disabled={!composerText.trim() || !workWorkspaceId || !workProvider || !workModel}
                        onClick={() => {
                          void handleStartFromComposer();
                        }}
                        type="button"
                      >
                        <Play className="h-3 w-3" /> Run
                      </button>
                      <button
                        className="rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                        disabled={!selectedSessionId || !composerText.trim()}
                        onClick={() => {
                          void handleSendChat();
                        }}
                        type="button"
                      >
                        Send
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <section className="flex min-h-0 flex-1 flex-col">
                <header className="border-b border-slate-200 bg-white px-4 py-3 text-xs font-bold uppercase tracking-widest text-slate-500">
                  Todo Checklist
                </header>
                <div className="flex gap-2 border-b border-slate-100 bg-slate-50 p-3">
                  <input
                    className="flex-1 rounded border border-slate-200 px-2 py-1.5 text-sm"
                    disabled={!selectedSessionId}
                    onChange={(event) => setTodoInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        void handleAddTodo();
                      }
                    }}
                    placeholder="Add todo item..."
                    value={todoInput}
                  />
                  <button
                    className="rounded border border-slate-200 bg-white px-3 text-sm disabled:opacity-50"
                    disabled={!selectedSessionId || !todoInput.trim()}
                    onClick={() => {
                      void handleAddTodo();
                    }}
                  >
                    Add
                  </button>
                </div>
                <div className="min-h-0 flex-1 space-y-1 overflow-auto p-4">
                  {todos.length === 0 && <div className="text-center text-xs italic text-slate-400">No todos yet.</div>}
                  {todos.map((todo) => (
                    <button
                      key={todo.id}
                      className="flex w-full items-center gap-2 rounded border border-slate-100 bg-white p-2 text-left text-sm"
                      onClick={() => {
                        void handleToggleTodo(todo);
                      }}
                    >
                      <CheckCircle2 className={`h-4 w-4 ${todo.done ? 'text-emerald-500' : 'text-slate-300'}`} />
                      <span className={todo.done ? 'line-through text-slate-400' : 'text-slate-700'}>{todo.text}</span>
                    </button>
                  ))}
                </div>
              </section>
            </aside>
          </div>
        ) : (
          <div className="h-full overflow-auto p-8">
            <h2 className="mb-5 flex items-center gap-2 text-2xl font-bold text-slate-800">
              <Settings className="h-6 w-6" />
              Environment Settings
            </h2>

            <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500">Providers</h3>
              <div className="space-y-2">
                {providers.map((provider) => {
                  const status = providerStatuses.find((entry) => entry.provider === provider.id)?.source ?? 'none';
                  return (
                    <div key={provider.id} className="flex items-center justify-between rounded border border-slate-100 bg-slate-50 px-3 py-2 text-sm">
                      <span className="font-mono text-slate-700">{provider.id}</span>
                      <span className={`rounded px-2 py-0.5 text-xs ${status === 'none' ? 'bg-slate-200 text-slate-600' : 'bg-emerald-100 text-emerald-700'}`}>
                        {status}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500">Workspaces</h3>
              <div className="space-y-2">
                {workspaces.map((workspace) => (
                  <div key={workspace.id} className="flex items-center justify-between rounded border border-slate-100 bg-slate-50 px-3 py-2 text-sm">
                    <span className="truncate font-mono text-xs text-slate-600">{workspace.path}</span>
                    {workspace.id === activeWorkspaceId && (
                      <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700">active</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>

      {errorMessage && (
        <div className="fixed bottom-3 right-3 max-w-xl rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 shadow">
          {errorMessage}
        </div>
      )}
    </div>
  );
}
