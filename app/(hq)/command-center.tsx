"use client";

import { useEffect, useState } from "react";
import type { BoardSnapshot, ChatResult, UiCard } from "../ui-types";

type Tab = "chat" | "board" | "swarm" | "inbox";

function Card({ card }: { card: UiCard }) {
  return (
    <article className="card" data-crew={card.crew} data-testid="plan-card">
      <strong>{card.title}</strong>
      <div className="muted">
        {card.crew} · {card.tier} · {card.tasksDone} of {card.tasksTotal}
      </div>
      {card.badges.map((badge) => (
        <span className="badge" key={badge}>{badge}</span>
      ))}
      {card.blocker ? <div className="muted">{card.blocker}</div> : null}
      <div className="muted" data-testid="routing">
        {card.model ?? "no run"} · {card.pool ?? "no pool"} · {card.routingReason ?? "no reason"}
      </div>
      <div className="muted">Updated {card.updatedAt}</div>
    </article>
  );
}

function Column({ title, cards }: { title: string; cards: UiCard[] }) {
  return (
    <section className="column">
      <h3>{title}</h3>
      {cards.length === 0 ? <p className="muted">None</p> : cards.map((card) => <Card card={card} key={card.id} />)}
    </section>
  );
}

export function CommandCenter({ initial }: { initial: BoardSnapshot }) {
  const [board, setBoard] = useState(initial);
  const [tab, setTab] = useState<Tab>("chat");
  const [text, setText] = useState("");
  const [draft, setDraft] = useState("");
  const [calls, setCalls] = useState<number | null>(null);
  const [stopNote, setStopNote] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
    const timer = setInterval(() => {
      void fetch("/api/board")
        .then((response) => response.json())
        .then((next: BoardSnapshot) => setBoard(next))
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  async function send(event: { preventDefault(): void }) {
    event.preventDefault();
    const message = text.trim();
    if (!message) return;
    setText("");
    setDraft("");
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ text: message }),
    });
    if (!response.ok || !response.body) {
      setDraft(`The chat route returned ${response.status}.`);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const apply = async (part: string) => {
      const line = part.replace(/^data: /, "").trim();
      if (!line) return;
      const event = JSON.parse(line) as { delta?: string; done?: ChatResult };
      if (event.delta) setDraft((current) => current + event.delta);
      if (event.done) {
        setCalls(event.done.modelCalls);
        setDraft("");
        const next = await fetch("/api/board").then((item) => item.json() as Promise<BoardSnapshot>);
        setBoard(next);
      }
    };
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) await apply(part);
    }
    if (buffer.trim()) await apply(buffer);
  }

  async function stopAll() {
    const response = await fetch("/api/stop", { method: "POST" });
    const body = (await response.json()) as { reports?: { state: string }[]; asOf?: string };
    const counts = (body.reports ?? []).map((report) => report.state).join(", ") || "no live runs";
    setStopNote(`${counts}. As of ${body.asOf ?? board.asOf}`);
    const next = await fetch("/api/board").then((item) => item.json() as Promise<BoardSnapshot>);
    setBoard(next);
  }

  return (
    <div className="shell" data-ready={ready ? "1" : "0"}>
      <header className="top">
        <div className="brand">Dexter.</div>
        <button className="stop" type="button" onClick={() => void stopAll()}>STOP ALL</button>
        <div className="meta">
          <span>Run slots {board.slotsUsed} of {board.slotCap}</span>
          <span>Quota {board.quotas}</span>
          <span>Spent this month {board.spend}</span>
          <span>As of {board.asOf}</span>
        </div>
      </header>
      <nav className="tabs" aria-label="Sections">
        {(["chat", "board", "swarm", "inbox"] as const).map((name) => (
          <button key={name} type="button" aria-pressed={tab === name} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </nav>
      <main className="grid">
        <section className={`panel ${tab === "board" ? "show" : ""}`} data-panel="board">
          <h2>Request board</h2>
          <Column title="Needs you" cards={board.columns.needsYou} />
          <Column title="Active" cards={board.columns.active} />
          <Column title="Queued" cards={board.columns.queued} />
          <Column title="Done" cards={board.columns.done} />
        </section>
        <section className={`panel ${tab === "swarm" ? "show" : ""}`} data-panel="swarm">
          <h2>Swarm view</h2>
          {board.swarm.length === 0 ? <p className="empty">No tasks drawn.</p> : (
            <ul>
              {board.swarm.map((node) => (
                <li key={node.id} data-testid="swarm-node">
                  {node.persona} · {node.state} · {node.model ?? "no model"} · {node.pool ?? "no pool"} · {node.routingReason ?? "no reason"}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className={`panel ${tab === "chat" || tab === "inbox" ? "show" : ""}`} data-panel="chat">
          <h2>{tab === "inbox" ? "Inbox" : "Dexter"}</h2>
          <div className="chat-log" data-testid="chat-log">
            {board.messages.map((message, index) => (
              <div className={`bubble ${message.role}`} key={`${message.at}-${index}`}>
                {message.body}
              </div>
            ))}
            {draft ? <div className="bubble dexter">{draft}</div> : null}
          </div>
          {calls !== null ? <p className="muted" data-testid="model-calls">Model calls {calls}</p> : null}
          {stopNote ? <p className="muted">{stopNote}</p> : null}
          <form className="dock" onSubmit={(event) => void send(event)}>
            <textarea aria-label="Message Dexter" value={text} onChange={(event) => setText(event.target.value)} />
            <button type="button" onClick={(event) => void send(event)}>Send</button>
          </form>
        </section>
      </main>
    </div>
  );
}
