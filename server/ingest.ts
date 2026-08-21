/**
 * Bulk ingest — dump .txt / .md / .jsonl from another AI (or a language
 * corpus) into knowledge + optional training chat pairs, then the local
 * brain can retrain in the background.
 */

export interface IngestFile {
  name: string;
  content: string;
}

export interface IngestChunk {
  title: string;
  content: string;
}

export interface IngestPair {
  user: string;
  ai: string;
}

export interface IngestPlan {
  chunks: IngestChunk[];
  pairs: IngestPair[];
  bytes: number;
  skippedEmpty: number;
}

const MAX_FILE_CHARS = 800_000;
const CHUNK_CHARS = 3500;

/** Split a long document into overlapping-ish paragraphs that fit RAG. */
export function chunkText(title: string, raw: string): IngestChunk[] {
  const text = (raw || "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: IngestChunk[] = [];
  let buf = "";
  let n = 1;
  const flush = () => {
    const c = buf.trim();
    if (c) {
      chunks.push({ title: chunks.length === 0 ? title : `${title} (${n})`, content: c });
      n++;
    }
    buf = "";
  };
  for (const p of paras) {
    if ((buf + "\n\n" + p).length > CHUNK_CHARS && buf) flush();
    buf = buf ? buf + "\n\n" + p : p;
    if (buf.length > CHUNK_CHARS) flush();
  }
  flush();
  return chunks;
}

/** Detect Q/A turns inside a plain transcript. */
const QA_RE =
  /^(?:user|human|question|q|প্রশ্ন|ইউজার)\s*[:\-–]\s*(.+)$/i;

const AA_RE =
  /^(?:ai|assistant|bot|answer|a|উত্তর|এআই)\s*[:\-–]\s*(.+)$/i;

export function extractPairs(text: string): IngestPair[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const pairs: IngestPair[] = [];
  let pending: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const q = t.match(QA_RE);
    if (q) {
      pending = q[1].trim();
      continue;
    }
    const a = t.match(AA_RE);
    if (a && pending) {
      pairs.push({ user: pending, ai: a[1].trim() });
      pending = null;
    }
  }
  return pairs;
}

function parseJsonl(name: string, content: string): IngestPlan {
  const chunks: IngestChunk[] = [];
  const pairs: IngestPair[] = [];
  let skippedEmpty = 0;
  const lines = content.split("\n");
  let i = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let obj: any;
    try {
      obj = JSON.parse(t);
    } catch {
      skippedEmpty++;
      continue;
    }
    i++;
    if (Array.isArray(obj?.messages)) {
      const msgs = obj.messages as { role?: string; content?: string }[];
      for (let k = 0; k < msgs.length - 1; k++) {
        if (msgs[k]?.role === "user" && msgs[k + 1]?.role === "assistant" && msgs[k].content && msgs[k + 1].content) {
          pairs.push({ user: String(msgs[k].content), ai: String(msgs[k + 1].content) });
        }
      }
      continue;
    }
    if (obj?.instruction && obj?.output) {
      pairs.push({ user: String(obj.instruction), ai: String(obj.output) });
      continue;
    }
    if (obj?.prompt && obj?.completion) {
      pairs.push({ user: String(obj.prompt), ai: String(obj.completion) });
      continue;
    }
    const body = String(obj?.text || obj?.content || obj?.body || "").trim();
    if (body) chunks.push({ title: `${name} #${i}`, content: body.slice(0, CHUNK_CHARS) });
    else skippedEmpty++;
  }
  return { chunks, pairs, bytes: content.length, skippedEmpty };
}

export function planIngest(files: IngestFile[]): IngestPlan {
  const chunks: IngestChunk[] = [];
  const pairs: IngestPair[] = [];
  let bytes = 0;
  let skippedEmpty = 0;
  for (const f of files) {
    const name = (f.name || "untitled").replace(/[/\\]/g, "_").slice(0, 80);
    let content = String(f.content || "");
    if (content.length > MAX_FILE_CHARS) content = content.slice(0, MAX_FILE_CHARS);
    bytes += content.length;
    if (!content.trim()) {
      skippedEmpty++;
      continue;
    }
    const lower = name.toLowerCase();
    if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson") || content.trimStart().startsWith("{")) {
      const looksJsonl = content.split("\n").filter((l) => l.trim()).every((l) => {
        try {
          JSON.parse(l.trim());
          return true;
        } catch {
          return false;
        }
      });
      if (looksJsonl) {
        const p = parseJsonl(name, content);
        chunks.push(...p.chunks);
        pairs.push(...p.pairs);
        skippedEmpty += p.skippedEmpty;
        continue;
      }
    }
    const qa = extractPairs(content);
    pairs.push(...qa);
    chunks.push(...chunkText(name.replace(/\.[^.]+$/, "") || name, content));
  }
  return { chunks, pairs, bytes, skippedEmpty };
}

export interface ApplyIngestResult {
  knowledgeInserted: number;
  pairsInserted: number;
  conversationId: number | null;
  bytes: number;
}

/** Write the plan into SQLite. Caller mirrors to Telegram. */
export function applyIngest(
  db: any,
  plan: IngestPlan,
  opts: { source?: string; conversationTitle?: string } = {}
): ApplyIngestResult {
  const source = opts.source || "ingest";
  let knowledgeInserted = 0;
  let pairsInserted = 0;
  let conversationId: number | null = null;

  const tx = db.transaction(() => {
    for (const c of plan.chunks) {
      db.prepare("INSERT INTO knowledge (title, content) VALUES (?, ?)").run(c.title, c.content);
      knowledgeInserted++;
    }
    if (plan.pairs.length > 0) {
      const title = opts.conversationTitle || `Ingest ${new Date().toISOString().slice(0, 16)}`;
      const info = db.prepare("INSERT INTO conversations (title) VALUES (?)").run(title);
      conversationId = Number(info.lastInsertRowid);
      const ins = db.prepare(
        "INSERT INTO chat_messages (session_id, role, content, source) VALUES (?, ?, ?, ?)"
      );
      for (const p of plan.pairs) {
        ins.run(conversationId, "user", p.user, source);
        ins.run(conversationId, "ai", p.ai, source);
        pairsInserted++;
      }
    }
  });
  tx();
  return { knowledgeInserted, pairsInserted, conversationId, bytes: plan.bytes };
}
