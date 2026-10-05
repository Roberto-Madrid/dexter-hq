"use client";

import { useEffect, useRef, useState } from "react";
import "./control-tower.css";
import { EXAMPLE_LABEL, STATUS_COPY, type GraphModel, type RequestStatus } from "./example-fixture";
import {
  exampleTowerSnapshot,
  usesExampleFixtures,
  type TowerBot,
  type TowerNeed,
  type TowerRequest,
  type TowerSnapshot,
} from "./tower-model";

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
  rules,
  example,
}: {
  graph: GraphModel;
  rules: { left?: boolean; right?: boolean; bottom?: boolean };
  example: boolean;
}) {
  return (
    <div className="field" data-testid="swarm-field" data-source={example ? "example" : "live"}>
      <svg
        className="g"
        viewBox={`0 0 ${graph.width} ${graph.height}`}
        preserveAspectRatio="none"
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
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {graph.nodes.map((node, index) => (
          <circle key={`n-${index}`} cx={node.cx} cy={node.cy} r={node.r} fill={node.fill} />
        ))}
      </svg>
      {graph.labels.map((label, index) => (
        <div
          className="nl"
          key={`l-${index}`}
          style={{
            left: `${(label.left / graph.width) * 100}%`,
            top: `${(label.top / graph.height) * 100}%`,
            width: `${(label.width / graph.width) * 100}%`,
            textAlign: label.align,
            color: label.color,
            fontWeight: label.weight,
          }}
        >
          {label.lines.map((line, lineIndex) => (
            <span key={lineIndex}>
              {lineIndex > 0 ? <br /> : null}
              {line}
            </span>
          ))}
        </div>
      ))}
      <div className="gst">{graph.status}</div>
      {example ? <div className="ex graph-ex">{EXAMPLE_LABEL}</div> : null}
      {rules.left ? <div className="rule-l" /> : null}
      {rules.right ? <div className="rule-r" /> : null}
      {rules.bottom ? <div className="rule-b" /> : null}
    </div>
  );
}

function RequestRows({ requests, onOpen }: { requests: TowerRequest[]; onOpen: (id: string) => void }) {
  return (
    <>
      {requests.map((request) => (
        <button className="row" type="button" key={request.id} onClick={() => onOpen(request.id)}>
          <div className="rt">{request.title}</div>
          <div className="row-meta">
            <span className={statusClass(request.status)}>{STATUS_COPY[request.status]}</span>
            <span className="owner">{request.owner}</span>
          </div>
        </button>
      ))}
    </>
  );
}

function statusClass(status: RequestStatus) {
  return status;
}

function NeedList({
  needs,
  onDecide,
}: {
  needs: TowerNeed[];
  onDecide: (id: string, decision: "approved" | "denied") => void;
}) {
  return (
    <>
      {needs.map((need) => (
        <div className="need" key={need.id}>
          {need.text}
          <div className="acts">
            <button type="button" onClick={() => onDecide(need.id, "approved")}>
              Approve
            </button>
            <button type="button" onClick={() => onDecide(need.id, "denied")}>
              Deny
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

function BotList({ bots }: { bots: TowerBot[] }) {
  return (
    <>
      {bots.map((bot) => (
        <div className="bot" key={bot.name}>
          <span>{bot.name}</span>
          <span className={`bst ${bot.state === "waiting" || bot.state === "stale" ? "wait" : bot.state}`}>
            {bot.state}
          </span>
        </div>
      ))}
    </>
  );
}

function ExampleMark({ show }: { show: boolean }) {
  if (!show) return null;
  return <div className="ex">{EXAMPLE_LABEL}</div>;
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
  const countsExample = view.counts.some((item) => item.source === "example");

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

  return (
    <div className="tower" data-ready={ready ? "1" : "0"} data-example={example ? "1" : "0"}>
      <header className="bar">
        <button className="word" type="button" onClick={goHome}>
          DEXTER
        </button>
        <div className="counts" aria-label={countsExample ? "Example counts" : "Live counts"}>
          {view.counts.map((item) => (
            <span className="count" data-source={item.source} key={item.label}>
              <span className="cw">{item.label}</span> <span className="cn">{item.value}</span>
              {item.source === "example" && mixedCounts ? <span className="ex-mark">{EXAMPLE_LABEL}</span> : null}
            </span>
          ))}
        </div>
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
      </header>

      <div className="phone-brand">
        <button className="word" type="button" onClick={goHome}>
          DEXTER
        </button>
        {example ? <div className="ex">{EXAMPLE_LABEL}</div> : null}
      </div>
      <div className="phone-stop">
        {stopped ? (
          <button className="presume" type="button" onClick={() => void resume()}>
            Resume
          </button>
        ) : null}
        <button className="pstop" type="button" onClick={() => void halt()}>
          STOP ALL
        </button>
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
            <div className="doc" data-source={view.requests.source}>
              <ExampleMark show={view.requests.source === "example"} />
              <h1>{open.title}</h1>
              <div className="who">{open.owner}</div>
              <div className="st">{STATUS_COPY[open.status]}</div>
              {open.body ? <p>{open.body}</p> : null}
            </div>
            <div className="desk-pane">
              <GraphField
                graph={view.swarm.request}
                rules={{ left: true, bottom: true }}
                example={view.swarm.source === "example"}
              />
            </div>
          </>
        ) : (
          <>
            <aside className="requests" data-source={view.requests.source}>
              <ExampleMark show={view.requests.source === "example"} />
              <RequestRows requests={view.requests.items} onOpen={openRequest} />
            </aside>
            <div className="desk-pane">
              <GraphField
                graph={view.swarm.desktop}
                rules={{ left: true, right: true, bottom: true }}
                example={view.swarm.source === "example"}
              />
            </div>
            <aside className="side">
              <section className="grp" data-source={view.needs.source}>
                <div className="gl">Needs you</div>
                {view.needs.source === "example" ? <ExampleMark show /> : null}
                <NeedList needs={openNeeds} onDecide={decide} />
              </section>
              <section className="grp" data-source={view.bots.source}>
                <div className="gl">Bots</div>
                {view.bots.source === "example" ? <ExampleMark show /> : null}
                <BotList bots={view.bots.items} />
              </section>
              <section className="grp" data-source={view.ceo.source}>
                <div className="gl">CEO</div>
                {view.ceo.source === "example" ? <ExampleMark show /> : null}
                {view.ceo.items.map((line) => (
                  <div className="ceo" key={line}>
                    {line}
                  </div>
                ))}
              </section>
            </aside>
          </>
        )}

        <div className="phone-main">
          {screen === "request" && open ? (
            <div className="phone-doc">
              {view.requests.source === "example" ? <div className="ex">{EXAMPLE_LABEL}</div> : null}
              <h1>{open.title}</h1>
              <div className="who">{open.owner}</div>
              <div className="st">{STATUS_COPY[open.status]}</div>
              {open.body ? <p>{open.body}</p> : null}
            </div>
          ) : null}
          {screen === "home" && tab === "requests" ? (
            <RequestRows requests={view.requests.items} onOpen={openRequest} />
          ) : null}
          {screen === "home" && tab === "swarm" ? (
            <GraphField graph={view.swarm.phone} rules={{}} example={view.swarm.source === "example"} />
          ) : null}
          {screen === "home" && tab === "bots" ? <BotList bots={view.bots.items} /> : null}
          {screen === "home" && tab === "needs" ? <NeedList needs={openNeeds} onDecide={decide} /> : null}
        </div>
      </div>
    </div>
  );
}
