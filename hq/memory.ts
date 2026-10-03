import { randomUUID } from "node:crypto";
import { requestTransitionAllowed, taskTransitionAllowed } from "../kernel/state.ts";
import type {
  ArtifactRow,
  HqStore,
  MessageRow,
  OutcomeRow,
  PostRow,
  RequestRow,
  RunRow,
  TaskRow,
} from "./model.ts";

export class MemoryStore implements HqStore {
  private requests: RequestRow[] = [];
  private tasks: TaskRow[] = [];
  private runs: RunRow[] = [];
  private messages: MessageRow[] = [];
  private posts: PostRow[] = [];
  private artifacts: ArtifactRow[] = [];
  private outcomes: OutcomeRow[] = [];
  private callbacks = new Set<string>();
  private slots = 0;
  private pools = new Map<string, number>();
  private stop = false;
  private approvals = new Set<string>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  now(): string {
    return this.clock().toISOString();
  }

  async listRequests(): Promise<RequestRow[]> {
    return this.requests.map((row) => ({ ...row, notices: [...row.notices] }));
  }

  async listTasks(): Promise<TaskRow[]> {
    return this.tasks.map((row) => ({ ...row, dependencies: [...row.dependencies] }));
  }

  async listRuns(): Promise<RunRow[]> {
    return this.runs.map((row) => ({ ...row, usage: { ...row.usage } }));
  }

  async listMessages(): Promise<MessageRow[]> {
    return [...this.messages];
  }

  async listPosts(): Promise<PostRow[]> {
    return this.posts.map((row) => ({ ...row, evidence: [...row.evidence] }));
  }

  async listArtifacts(): Promise<ArtifactRow[]> {
    return [...this.artifacts];
  }

  async listOutcomes(): Promise<OutcomeRow[]> {
    return [...this.outcomes];
  }

  async addMessage(role: string, body: string, requestId: string | null): Promise<void> {
    this.messages.push({ role, body, at: this.now(), requestId });
  }

  async saveRequest(row: RequestRow): Promise<void> {
    this.requests.push(row);
  }

  async saveTasks(rows: TaskRow[]): Promise<void> {
    this.tasks.push(...rows);
  }

  async patchRequest(id: string, patch: Partial<Pick<RequestRow, "status" | "notices" | "updatedAt">>): Promise<void> {
    const row = this.requests.find((item) => item.id === id);
    if (!row) throw new Error("missing_request");
    if (patch.status && patch.status !== row.status) {
      if (!requestTransitionAllowed(row.status, patch.status)) {
        throw new Error(`bad_request_${row.status}_${patch.status}`);
      }
      row.status = patch.status;
    }
    if (patch.notices) row.notices = [...patch.notices];
    row.updatedAt = patch.updatedAt ?? this.now();
  }

  async patchTask(id: string, patch: Partial<TaskRow>): Promise<void> {
    const row = this.tasks.find((item) => item.id === id);
    if (!row) throw new Error("missing_task");
    if (patch.state && patch.state !== row.state) {
      if (!taskTransitionAllowed(row.state, patch.state)) {
        throw new Error(`bad_transition_${row.state}_${patch.state}`);
      }
      row.state = patch.state;
    }
    const rest: Partial<TaskRow> = { ...patch };
    delete rest.state;
    Object.assign(row, rest);
  }

  async saveRun(row: RunRow): Promise<void> {
    this.runs.push(row);
  }

  async patchRun(id: string, patch: Partial<RunRow>): Promise<void> {
    const row = this.runs.find((item) => item.id === id);
    if (!row) throw new Error("missing_run");
    Object.assign(row, patch);
  }

  async activeSlots(): Promise<number> {
    return this.slots;
  }

  async setActiveSlots(value: number): Promise<void> {
    this.slots = value;
  }

  async poolReserved(pool: string): Promise<number> {
    return this.pools.get(pool) ?? 0;
  }

  async setPoolReserved(pool: string, value: number): Promise<void> {
    this.pools.set(pool, value);
  }

  async stopped(): Promise<boolean> {
    return this.stop;
  }

  async setStopped(value: boolean): Promise<void> {
    this.stop = value;
  }

  async seenCallback(id: string): Promise<boolean> {
    return this.callbacks.has(id);
  }

  async rememberCallback(id: string): Promise<void> {
    this.callbacks.add(id);
  }

  async addPost(row: PostRow): Promise<void> {
    this.posts.push(row);
  }

  async addArtifact(row: ArtifactRow): Promise<void> {
    this.artifacts.push(row);
  }

  async addOutcome(row: OutcomeRow): Promise<void> {
    this.outcomes.push(row);
  }

  async approved(requestId: string): Promise<boolean> {
    return this.approvals.has(requestId);
  }

  grant(requestId: string): void {
    this.approvals.add(requestId);
  }

  dump(): string {
    return JSON.stringify({
      requests: this.requests,
      tasks: this.tasks,
      runs: this.runs,
      messages: this.messages,
      posts: this.posts,
      artifacts: this.artifacts,
      outcomes: this.outcomes,
      callbacks: [...this.callbacks],
      slots: this.slots,
      pools: [...this.pools.entries()],
      stop: this.stop,
      approvals: [...this.approvals],
    });
  }

  load(raw: string): void {
    const data = JSON.parse(raw) as {
      requests: RequestRow[];
      tasks: TaskRow[];
      runs: RunRow[];
      messages: MessageRow[];
      posts: PostRow[];
      artifacts: ArtifactRow[];
      outcomes: OutcomeRow[];
      callbacks: string[];
      slots: number;
      pools: [string, number][];
      stop: boolean;
      approvals: string[];
    };
    this.requests = data.requests ?? [];
    this.tasks = data.tasks ?? [];
    this.runs = data.runs ?? [];
    this.messages = data.messages ?? [];
    this.posts = data.posts ?? [];
    this.artifacts = data.artifacts ?? [];
    this.outcomes = data.outcomes ?? [];
    this.callbacks = new Set(data.callbacks ?? []);
    this.slots = data.slots ?? 0;
    this.pools = new Map(data.pools ?? []);
    this.stop = data.stop ?? false;
    this.approvals = new Set(data.approvals ?? []);
  }
}

export function newId(): string {
  return randomUUID();
}
