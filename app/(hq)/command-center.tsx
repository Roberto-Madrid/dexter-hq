"use client";

import { useEffect, useState } from "react";
import "./control-tower.css";
import {
  EXAMPLE_LABEL,
  STATUS_COPY,
  desktopGraph,
  exampleBots,
  exampleCeo,
  exampleCounts,
  exampleNeeds,
  exampleRequests,
  phoneGraph,
  requestGraph,
  type GraphModel,
  type RequestStatus,
} from "./example-fixture";

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
}: {
  graph: GraphModel;
  rules: { left?: boolean; right?: boolean; bottom?: boolean };
}) {
  return (
    <div className="field" data-testid="swarm-field">
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
      {rules.left ? <div className="rule-l" /> : null}
      {rules.right ? <div className="rule-r" /> : null}
      {rules.bottom ? <div className="rule-b" /> : null}
    </div>
  );
}

function RequestRows({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <>
      {exampleRequests.map((request) => (
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

function NeedList() {
  return (
    <>
      {exampleNeeds.map((need) => (
        <div className="need" key={need}>
          {need}
          <div className="acts">
            <span>Approve</span>
            <span>Deny</span>
          </div>
        </div>
      ))}
    </>
  );
}

function BotList() {
  return (
    <>
      {exampleBots.map((bot) => (
        <div className="bot" key={bot.name}>
          <span>{bot.name}</span>
          <span className={`bst ${bot.state === "waiting" ? "wait" : bot.state}`}>
            {bot.state === "waiting" ? "waiting" : bot.state}
          </span>
        </div>
      ))}
    </>
  );
}

export function CommandCenter() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("requests");
  const [screen, setScreen] = useState<Screen>("home");
  const [openId, setOpenId] = useState(exampleRequests[0].id);

  useEffect(() => {
    setReady(true);
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
  }, []);

  const open = exampleRequests.find((item) => item.id === openId) ?? exampleRequests[0];

  function openRequest(id: string) {
    setOpenId(id);
    setScreen("request");
  }

  function goHome() {
    setScreen("home");
  }

  return (
    <div className="tower" data-ready={ready ? "1" : "0"} data-example="1">
      <header className="bar">
        <button className="word" type="button" onClick={goHome}>
          DEXTER
        </button>
        <div className="counts" aria-label="Example counts">
          {exampleCounts.map((item) => (
            <span className="count" key={item.label}>
              <span className="cw">{item.label}</span> <span className="cn">{item.value}</span>
            </span>
          ))}
        </div>
        <button className="halt" type="button">
          STOP ALL
        </button>
      </header>

      <div className="phone-brand">
        <button className="word" type="button" onClick={goHome}>
          DEXTER
        </button>
        <div className="ex">{EXAMPLE_LABEL}</div>
      </div>
      <button className="pstop" type="button">
        STOP ALL
      </button>
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
        {screen === "request" ? (
          <>
            <div className="doc">
              <div className="ex" style={{ padding: 0 }}>
                {EXAMPLE_LABEL}
              </div>
              <h1>{open.title}</h1>
              <div className="who">{open.owner}</div>
              <div className="st">{STATUS_COPY[open.status]}</div>
              {open.body ? <p>{open.body}</p> : null}
            </div>
            <div className="desk-pane">
              <GraphField graph={requestGraph} rules={{ left: true, bottom: true }} />
            </div>
          </>
        ) : (
          <>
            <aside className="requests">
              <div className="ex">{EXAMPLE_LABEL}</div>
              <RequestRows onOpen={openRequest} />
            </aside>
            <div className="desk-pane">
              <GraphField graph={desktopGraph} rules={{ left: true, right: true, bottom: true }} />
            </div>
            <aside className="side">
              <section className="grp">
                <div className="gl">Needs you</div>
                <NeedList />
              </section>
              <section className="grp">
                <div className="gl">Bots</div>
                <BotList />
              </section>
              <section className="grp">
                <div className="gl">CEO</div>
                <div className="ceo">{exampleCeo}</div>
              </section>
            </aside>
          </>
        )}

        <div className="phone-main">
          {screen === "request" ? (
            <div className="phone-doc">
              <h1>{open.title}</h1>
              <div className="who">{open.owner}</div>
              <div className="st">{STATUS_COPY[open.status]}</div>
              {open.body ? <p>{open.body}</p> : null}
            </div>
          ) : null}
          {screen === "home" && tab === "requests" ? <RequestRows onOpen={openRequest} /> : null}
          {screen === "home" && tab === "swarm" ? <GraphField graph={phoneGraph} rules={{}} /> : null}
          {screen === "home" && tab === "bots" ? <BotList /> : null}
          {screen === "home" && tab === "needs" ? <NeedList /> : null}
        </div>
      </div>
    </div>
  );
}
