/**
 * Job scan (Stage 4 crew `job-scan`): collector -> filters -> fast fit score -> Career brief -> Inbox.
 * The collector is the career persona posting leads to the board; everything here is deterministic (tier T0):
 * parse the week's leads, drop what does not fit, score the rest, and rank them. The brief only informs the owner:
 * it never applies, messages, or signs up for anything (applications stay behind an approval card).
 */

/** First line of a lead note: `Job lead: <title> at <company>`, then optional `key: value` lines. */
export const JOB_LEAD_PREFIX = "Job lead:";
const RECENT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type JobScanPrefs = {
  /** Keywords that make a lead fit (whole words, any case). */
  include: string[];
  /** Keywords that drop a lead outright. */
  exclude: string[];
  remoteOnly: boolean;
  minScore: number;
  top: number;
};

export type JobLead = {
  postId: string;
  title: string;
  company: string;
  location: string | null;
  remote: boolean | null;
  tags: string[];
  salary: string | null;
  postedAt: string | null;
  link: string | null;
  text: string;
};

/** The note shape the collector reads; a board post satisfies it. */
export type LeadNote = { id: string; body: string; link?: string | null; createdAt?: string | null };

export type RankedLead = Omit<JobLead, "text"> & { rank: number; score: number; reasons: string[] };
export type DropReason = "duplicate" | "excluded" | "not_remote" | "below_min_score";

export type JobScanBrief = {
  week: string;
  start: string;
  end: string;
  generatedAt: string;
  prefs: JobScanPrefs;
  collected: number;
  ranked: RankedLead[];
  dropped: Partial<Record<DropReason, number>>;
  /** Always empty: the scan informs, it never acts. Kept in the shape so readers can assert it. */
  outwardActions: never[];
};

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9+#.]+/).map((item) => item.replace(/\.+$/, "")).filter(Boolean));
}

function hits(keywords: readonly string[], text: string): string[] {
  const bag = words(text);
  return keywords.filter((keyword) => {
    const parts = keyword.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return false;
    if (parts.length === 1) return bag.has(parts[0]!);
    return ` ${[...text.toLowerCase().split(/[^a-z0-9+#.]+/)].join(" ")} `.includes(` ${parts.join(" ")} `);
  });
}

function yesNo(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  if (/^(yes|true|remote|y)$/i.test(value.trim())) return true;
  if (/^(no|false|onsite|on-site|n)$/i.test(value.trim())) return false;
  return null;
}

/** A lead from a note in the collector's format, or null for any other note. */
export function parseJobLead(note: LeadNote): JobLead | null {
  const lines = note.body.split("\n").map((line) => line.trim());
  const head = lines[0] ?? "";
  if (!head.startsWith(JOB_LEAD_PREFIX)) return null;
  const headline = head.slice(JOB_LEAD_PREFIX.length).trim();
  const at = headline.toLowerCase().lastIndexOf(" at ");
  const title = (at > 0 ? headline.slice(0, at) : headline).trim();
  const company = (at > 0 ? headline.slice(at + 4) : "").trim();
  if (!title) return null;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const match = line.match(/^([a-z_ ]+):\s*(.*)$/i);
    if (match) fields[match[1]!.trim().toLowerCase()] = match[2]!.trim();
  }
  const location = fields.location || null;
  const remote = yesNo(fields.remote) ?? (location && /\bremote\b/i.test(location) ? true : null);
  const posted = fields.posted && !Number.isNaN(Date.parse(fields.posted)) ? fields.posted : null;
  return {
    postId: note.id,
    title,
    company: company || "unknown company",
    location,
    remote,
    tags: (fields.tags ?? "").split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean),
    salary: fields.salary || null,
    postedAt: posted,
    link: note.link ?? null,
    text: note.body,
  };
}

/** Deterministic 0..100 fit: title keywords 20 each, tag or body keywords 10 each, remote 15, posted in 7 days 10. */
export function fitScore(lead: JobLead, prefs: JobScanPrefs, now: Date): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const inTitle = hits(prefs.include, lead.title);
  if (inTitle.length > 0) {
    score += 20 * inTitle.length;
    reasons.push(`title matches ${inTitle.join(", ")}`);
  }
  const rest = hits(prefs.include, `${lead.tags.join(" ")} ${lead.text}`).filter((keyword) => !inTitle.includes(keyword));
  if (rest.length > 0) {
    score += 10 * rest.length;
    reasons.push(`tags or notes match ${rest.join(", ")}`);
  }
  if (lead.remote === true) {
    score += 15;
    reasons.push("remote");
  }
  if (lead.postedAt && now.getTime() - Date.parse(lead.postedAt) <= RECENT_DAYS * DAY_MS) {
    score += 10;
    reasons.push(`posted within ${RECENT_DAYS} days`);
  }
  return { score: Math.min(100, score), reasons };
}

/** The week's brief from every board note created in [start, end). Notes outside the week are ignored. */
export function buildJobScanBrief(input: {
  week: { key: string; start: string; end: string };
  generatedAt: string;
  posts: readonly LeadNote[];
  prefs: JobScanPrefs;
}): JobScanBrief {
  const from = Date.parse(input.week.start);
  const to = Date.parse(input.week.end);
  const leads = input.posts
    .filter((post) => {
      const at = post.createdAt ? Date.parse(post.createdAt) : Number.NaN;
      return at >= from && at < to;
    })
    .map(parseJobLead)
    .filter((lead): lead is JobLead => lead !== null);
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (reason: DropReason) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const seen = new Set<string>();
  const now = new Date(input.generatedAt);
  const scored: (JobLead & { score: number; reasons: string[] })[] = [];
  for (const lead of leads) {
    const key = lead.link ? lead.link.toLowerCase() : `${lead.title}|${lead.company}`.toLowerCase();
    if (seen.has(key)) {
      drop("duplicate");
      continue;
    }
    seen.add(key);
    if (hits(input.prefs.exclude, `${lead.title} ${lead.tags.join(" ")} ${lead.text}`).length > 0) {
      drop("excluded");
      continue;
    }
    if (input.prefs.remoteOnly && lead.remote !== true) {
      drop("not_remote");
      continue;
    }
    const fit = fitScore(lead, input.prefs, now);
    if (fit.score < input.prefs.minScore) {
      drop("below_min_score");
      continue;
    }
    scored.push({ ...lead, ...fit });
  }
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.postId.localeCompare(b.postId));
  const ranked = scored.slice(0, Math.max(0, input.prefs.top)).map(({ text: _text, ...lead }, index) => ({ ...lead, rank: index + 1 }));
  return {
    week: input.week.key,
    start: input.week.start,
    end: input.week.end,
    generatedAt: input.generatedAt,
    prefs: input.prefs,
    collected: leads.length,
    ranked,
    dropped,
    outwardActions: [],
  };
}

export function renderJobScanBrief(brief: JobScanBrief): string {
  const lines = [`Job scan ${brief.week}: ${brief.ranked.length} of ${brief.collected} leads fit.`];
  for (const lead of brief.ranked) {
    const where = [lead.location, lead.remote === true ? "remote" : null, lead.salary].filter(Boolean).join(", ");
    lines.push(`${lead.rank}. ${lead.title} at ${lead.company}${where ? ` (${where})` : ""}, score ${lead.score}: ${lead.reasons.join("; ") || "no signals"}.`);
    if (lead.link) lines.push(`   ${lead.link}`);
  }
  const dropped = Object.entries(brief.dropped)
    .map(([reason, count]) => `${reason.replace(/_/g, " ")} ${count}`)
    .join(", ");
  if (dropped) lines.push(`Dropped: ${dropped}.`);
  if (brief.collected === 0) lines.push("No leads were posted this week.");
  lines.push("Nothing was applied to and nobody was contacted. To apply, ask Dexter; it raises an approval card first.");
  return lines.join("\n");
}
