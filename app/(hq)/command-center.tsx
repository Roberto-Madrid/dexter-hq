"use client";

import { useEffect, useRef, useState } from "react";
import "./control-tower.css";
import {
  EXAMPLE_LABEL,
  STATUS_COPY,
  type ChatMessage,
  type GraphModel,
  type RequestStatus,
} from "./example-fixture";
import {
  exampleTowerSnapshot,
  usesExampleFixtures,
  type TowerBot,
  type TowerNeed,
  type TowerRequest,
  type TowerSnapshot,
} from "./tower-model";
import { resumeClearsStop } from "./control-result";

type Tab = "requests" | "swarm" | "bots" | "needs";
type Screen = "home" | "request";

const TABS: { id: Tab; label: string }[] = [
  { id: "requests", label: "Requests" },
  { id: "swarm", label: "Swarm" },
  { id: "bots", label: "Bots" },
  { id: "needs", label: "Needs you" },
];

function GraphField({
  graph,
  example,
  className,
}: {
  graph: GraphModel;
  example: boolean;
  className?: string;
}) {
  const svg = graph.svgInner ? (
    <svg
      className="g"
      viewBox={`0 0 ${graph.width} ${graph.height}`}
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: graph.svgInner }}
    />
  ) : (
    <svg
      className="g"
      viewBox={`0 0 ${graph.width} ${graph.height}`}
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {graph.lines.map((line, index) => (
        <line
          key={`e-${index}`}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          stroke={line.stroke}
          strokeWidth={line.width ?? 1}
          strokeDasharray={line.dash}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {graph.nodes.map((node, index) => (
        <circle
          key={`n-${index}`}
          cx={node.cx}
          cy={node.cy}
          r={node.r}
          fill={node.fill}
          stroke={node.stroke}
          strokeDasharray={node.dash}
          opacity={node.opacity}
        />
      ))}
    </svg>
  );

  return (
    <div
      className={className ? `field ${className}` : "field"}
      data-testid="swarm-field"
      data-source={example ? "example" : "live"}
    >
      {svg}
      {graph.labels.map((label, index) =>
        label.lines.length === 0 ? null : (
          <div
            className="nl"
            key={`l-${index}`}
            style={{
              left: `${(label.left / graph.width) * 100}%`,
              top: `${(label.top / graph.height) * 100}%`,
              width: label.width ? `${(label.width / graph.width) * 100}%` : undefined,
              textAlign: label.align,
              color: label.color,
              fontWeight: label.weight,
              fontSize: label.fontSize,
            }}
          >
            {label.lines.map((line, lineIndex) => (
              <span key={lineIndex}>
                {lineIndex > 0 ? <br /> : null}
                {line}
              </span>
            ))}
          </div>
        ),
      )}
      <div className="gst mono">{graph.status}</div>
      {graph.legend ? (
        <div className="gleg mono" dangerouslySetInnerHTML={{ __html: graph.legend }} />
      ) : null}
      {example ? <div className="ex graph-ex">{EXAMPLE_LABEL}</div> : null}
    </div>
  );
}

function RequestRows({
  requests,
  selectedId,
  onOpen,
}: {
  requests: TowerRequest[];
  selectedId?: string;
  onOpen: (id: string) => void;
}) {
  return (
    <>
      {requests.map((request) => (
        <button
          className={selectedId === request.id ? "row on" : "row"}
          type="button"
          key={request.id}
          onClick={() => onOpen(request.id)}
        >
          <div className="rt">{request.title}</div>
          {request.events != null ? <div className="rcnt mono">{request.events}</div> : null}
          <div className="row-meta">
            <span className={statusClass(request.status)}>{STATUS_COPY[request.status]}</span>
            <span className="owner"> · {request.owner}</span>
            {request.age ? <span className="owner"> · {request.age}</span> : null}
          </div>
        </button>
      ))}
    </>
  );
}

function statusClass(status: RequestStatus) {
  return status;
}

function ChatThread({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="thread">
      {messages.map((msg, index) => (
        <div className={msg.role === "you" ? "msg you" : "msg dex"} key={`${msg.when}-${index}`}>
          <div className="meta">
            <span className="who">{msg.role === "you" ? "You" : "Dexter"}</span>
            {msg.when ? <span className="when mono">{msg.when}</span> : null}
          </div>
          <div className="bubble">{msg.text}</div>
        </div>
      ))}
    </div>
  );
}

function NeedList({
  needs,
  onDecide,
  stacked,
}: {
  needs: TowerNeed[];
  onDecide: (id: string, decision: "approved" | "denied") => void;
  stacked?: boolean;
}) {
  return (
    <>
      {needs.map((need) => (
        <div className={stacked ? "need-card" : "need"} key={need.id}>
          {stacked ? (
            <div className="need-lbl">{need.urgent ? "Needs you · Urgent" : "Needs you"}</div>
          ) : null}
          <div className="need-t">{need.text}</div>
          {need.owner || need.age ? (
            <div className="need-meta">
              Needs you
              {need.owner ? ` · ${need.owner}` : ""}
              {need.age ? ` · ${need.age}` : ""}
            </div>
          ) : null}
          <div className={stacked ? "acts stacked" : "acts"}>
            <button type="button" className="approve" onClick={() => onDecide(need.id, "approved")}>
              Approve
            </button>
            <button type="button" className="deny" onClick={() => onDecide(need.id, "denied")}>
              Deny
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

function BotTable({ bots }: { bots: TowerBot[] }) {
  return (
    <table className="bots">
      <thead>
        <tr>
          <th>Bot</th>
          <th>State</th>
          <th>HB</th>
        </tr>
      </thead>
      <tbody>
        {bots.map((bot) => {
          const label =
            bot.state === "live"
              ? "Live"
              : bot.state === "waiting" || bot.state === "stale"
                ? "Wait"
                : "Idle";
          const cell =
            bot.state === "live" ? "live" : bot.state === "waiting" || bot.state === "stale" ? "wait" : "idle";
          return (
            <tr key={bot.name}>
              <td>{bot.name}</td>
              <td className={`cell ${cell}`}>
                <span>{label}</span>
              </td>
              <td className="hb mono">{bot.hb ?? "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TrailList({ trail }: { trail: TowerSnapshot["requests"]["items"][0]["trail"] }) {
  if (!trail || trail.length === 0) return null;
  return (
    <details className="why">
      <summary>Why?</summary>
      {trail.map((entry, index) => (
        <div className="ceo" key={`${entry.at}-${index}`}>
          {entry.summary}
        </div>
      ))}
    </details>
  );
}

function ExampleMark({ show }: { show: boolean }) {
  if (!show) return null;
  return <div className="ex">{EXAMPLE_LABEL}</div>;
}

function healthOk(value: string): boolean {
  return value.includes("/") ? !value.startsWith("0/") : value.toLowerCase() === "ok" || value !== "0";
}

export function CommandCenter({ snapshot }: { snapshot?: TowerSnapshot }) {
  const view = snapshot ?? exampleTowerSnapshot();
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("requests");
  const [screen, setScreen] = useState<Screen>("home");
  const [openId, setOpenId] = useState(view.requests.items[0]?.id ?? "");
  const [settled, setSettled] = useState<Record<string, "approved" | "denied">>({});
  const [stopped, setStopped] = useState(view.stopped);
  const busy = useRef(false);
  const controlBusy = useRef(false);

  useEffect(() => {
    setReady(true);
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
  }, []);

  const open = view.requests.items.find((item) => item.id === openId) ?? view.requests.items[0];
  const example = usesExampleFixtures(view);
  const mixedCounts = view.counts.some((item) => item.source === "live") && view.counts.some((item) => item.source === "example");
  const agents = view.counts.find((item) => item.label === "Agents");
  const health = view.counts.find((item) => item.label === "Health");

  function openRequest(id: string) {
    setOpenId(id);
    setScreen("request");
  }

  function goHome() {
    setScreen("home");
  }

  async function postControl(path: "/api/stop" | "/api/resume"): Promise<boolean> {
    if (controlBusy.current) return false;
    controlBusy.current = true;
    try {
      const response = await fetch(path, { method: "POST", credentials: "same-origin" });
      if (path === "/api/resume") {
        const body: unknown = await response.json().catch(() => null);
        return resumeClearsStop(response.status, body);
      }
      return response.ok;
    } catch {
      return false;
    } finally {
      controlBusy.current = false;
    }
  }

  async function halt() {
    if (await postControl("/api/stop")) setStopped(true);
  }

  async function resume() {
    if (await postControl("/api/resume")) setStopped(false);
  }

  async function decide(id: string, decision: "approved" | "denied") {
    if (busy.current || settled[id]) return;
    busy.current = true;
    try {
      const response = await fetch("/api/approval", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId: id, decision }),
      });
      const body = (await response.json()) as { status?: string };
      if (body.status === "approved" || body.status === "denied") {
        const next = body.status;
        setSettled((prev) => ({ ...prev, [id]: next }));
      }
    } catch {
      // Keep the need visible when the route does not record a decision.
    } finally {
      busy.current = false;
    }
  }

  const openNeeds = view.needs.items.filter((need) => !settled[need.id]);
  const lastChat = view.chat.items[view.chat.items.length - 1];

  return (
    <div className="tower" data-ready={ready ? "1" : "0"} data-example={example ? "1" : "0"}>
      <header className="bar">
        <button className="brand" type="button" onClick={goHome}>
          Dexter HQ <span>Tower</span>
        </button>
        <div className="halt-group">
          {stopped ? (
            <button className="resume" type="button" onClick={() => void resume()}>
              Resume
            </button>
          ) : null}
          <button className="halt" type="button" onClick={() => void halt()}>
            STOP ALL
          </button>
        </div>
        <div className="metrics" aria-label="Live counts">
          {view.counts.map((item) => (
            <div className="metric" data-source={item.source} key={item.label}>
              <span className="k">{item.label}</span>
              <span className={item.label === "Health" && healthOk(item.value) ? "v mono ok" : "v mono"}>
                {item.value}
                {item.detail ? ` ${item.detail}` : ""}
              </span>
              {item.source === "example" && mixedCounts ? <span className="ex-mark">{EXAMPLE_LABEL}</span> : null}
            </div>
          ))}
        </div>
        {example ? <div className="ex corner">{EXAMPLE_LABEL}</div> : null}
      </header>

      <div className="phone-stop">
        {stopped ? (
          <button className="presume" type="button" onClick={() => void resume()}>
            Resume
          </button>
        ) : null}
        <button className="pstop" type="button" onClick={() => void halt()}>
          STOP ALL
        </button>
        {example ? <div className="ex corner">{EXAMPLE_LABEL}</div> : null}
      </div>
      <div className="phone-brand">
        <button className="brand" type="button" onClick={goHome}>
          Dexter HQ
        </button>
        <div className="phone-metrics mono">
          Agents <b>{agents?.value ?? "—"}</b>
          {agents?.detail ? ` ${agents.detail}` : ""} · Health{" "}
          <b className={health && healthOk(health.value) ? "ok" : undefined}>{health?.value ?? "—"}</b>
        </div>
      </div>
      <nav className="phone-tabs" aria-label="Sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? "tab on" : "tab"}
            type="button"
            aria-pressed={tab === item.id}
            onClick={() => {
              setTab(item.id);
              setScreen("home");
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="body">
        {screen === "request" && open ? (
          <>
            <aside className="requests" data-source={view.requests.source}>
              <div className="col-h">
                <strong>Requests</strong>
                <span className="mono">{view.requests.items.length}</span>
              </div>
              <ExampleMark show={view.requests.source === "example"} />
              <RequestRows requests={view.requests.items} selectedId={open.id} onOpen={openRequest} />
            </aside>
            <section className="detail" data-source={view.requests.source}>
              <div className="col-h">
                <strong>Open request</strong>
                <span>{open.owner}</span>
              </div>
              <div className="detail-body">
                <div className="crumb">Requests / {open.title}</div>
                <h1>{open.title}</h1>
                <div className="detail-meta">
                  <span className={statusClass(open.status)}>{STATUS_COPY[open.status]}</span>
                  <span> · Owner {open.owner}</span>
                  {open.age ? <span> · opened {open.age}</span> : null}
                  {open.events != null ? <span> · {open.events} events</span> : null}
                </div>
                {open.body ? (
                  <div className="summary">
                    <div className="lbl">Summary</div>
                    <p>{open.body}</p>
                  </div>
                ) : null}
                {openNeeds[0] ? (
                  <div className="needs-box">
                    <div className="lbl">Needs you</div>
                    <div className="item">
                      {openNeeds[0].text}
                      <div className="acts">
                        <button type="button" className="approve" onClick={() => void decide(openNeeds[0].id, "approved")}>
                          Approve
                        </button>
                        <button type="button" className="deny" onClick={() => void decide(openNeeds[0].id, "denied")}>
                          Deny
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
                <div className="activity">
                  <div className="lbl">Activity</div>
                  {view.activity.items.map((item, index) => (
                    <div className="act-row" key={`${item.text}-${index}`}>
                      <span className="when mono">{item.when || "—"}</span>
                      <span>{item.text}</span>
                    </div>
                  ))}
                </div>
                <TrailList trail={open.trail} />
              </div>
            </section>
            <aside className="chat-pane" data-source={view.chat.source}>
              <div className="col-h">
                <strong>Dexter</strong>
                <span>Chat context</span>
              </div>
              <ChatThread messages={view.chat.items} />
              <div className="composer">
                <div className="box">Reply…</div>
                <button className="send" type="button">
                  Send
                </button>
              </div>
            </aside>
          </>
        ) : (
          <>
            <aside className="requests" data-source={view.requests.source}>
              <div className="col-h">
                <strong>Requests</strong>
                <span className="mono">{view.requests.items.length}</span>
              </div>
              <ExampleMark show={view.requests.source === "example"} />
              <RequestRows requests={view.requests.items} selectedId={openId} onOpen={openRequest} />
            </aside>
            <section className="chat-pane main-chat" data-source={view.chat.source}>
              <div className="col-h">
                <strong>Dexter</strong>
                <span>CEO chat · Live</span>
              </div>
              <ChatThread messages={view.chat.items} />
              <div className="composer">
                <div className="box">Message Dexter…</div>
                <button className="send" type="button">
                  Send
                </button>
              </div>
            </section>
            <aside className="graph-col">
              <div className="col-h">
                <strong>Swarm</strong>
                <span>Dexter → leads → agents</span>
              </div>
              <GraphField graph={view.swarm.desktop} example={view.swarm.source === "example"} className="desk-swarm" />
              <div className="side-stack">
                <div className="panel" data-source={view.bots.source}>
                  <div className="col-h">
                    <strong>Bots</strong>
                    <span className="mono">{view.bots.items.length}</span>
                  </div>
                  <BotTable bots={view.bots.items} />
                </div>
                <div className="panel" data-source={view.needs.source}>
                  <div className="col-h">
                    <strong>Needs you</strong>
                    <span className="mono">{openNeeds.length}</span>
                  </div>
                  <div className="needs-box">
                    <div className="lbl">Awaiting owner</div>
                    <NeedList needs={openNeeds} onDecide={decide} />
                  </div>
                </div>
              </div>
            </aside>
          </>
        )}

        <div className="phone-main">
          {screen === "request" && open ? (
            <div className="phone-doc">
              {view.requests.source === "example" ? <div className="ex">{EXAMPLE_LABEL}</div> : null}
              <div className="need-lbl">Needs you · Urgent</div>
              <h1>{open.title}</h1>
              <div className="detail-meta">
                <span className={statusClass(open.status)}>{STATUS_COPY[open.status]}</span>
                <span> · {open.owner}</span>
                {open.age ? <span> · {open.age}</span> : null}
              </div>
              {open.body ? (
                <div className="needs-box">
                  <p>{open.body}</p>
                  {openNeeds[0] ? (
                    <div className="acts stacked">
                      <button type="button" className="approve" onClick={() => void decide(openNeeds[0].id, "approved")}>
                        Approve
                      </button>
                      <button type="button" className="deny" onClick={() => void decide(openNeeds[0].id, "denied")}>
                        Deny
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <TrailList trail={open.trail} />
            </div>
          ) : null}
          {screen === "home" && tab === "requests" ? (
            <>
              <RequestRows requests={view.requests.items} onOpen={openRequest} />
              {lastChat ? (
                <div className="peek" data-source={view.chat.source}>
                  <div className="lbl">Dexter · last message</div>
                  <div>
                    <span className="who">Dexter</span>{" "}
                    {lastChat.when ? <span className="when mono">{lastChat.when}</span> : null}
                  </div>
                  <div className="txt">{lastChat.text}</div>
                </div>
              ) : null}
            </>
          ) : null}
          {screen === "home" && tab === "swarm" ? (
            <GraphField graph={view.swarm.phone} example={view.swarm.source === "example"} />
          ) : null}
          {screen === "home" && tab === "bots" ? <BotTable bots={view.bots.items} /> : null}
          {screen === "home" && tab === "needs" ? (
            <div className="phone-needs">
              <NeedList needs={openNeeds} onDecide={decide} stacked />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
