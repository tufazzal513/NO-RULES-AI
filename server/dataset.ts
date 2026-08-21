/**
 * Dataset statistics for the control panel's Datasets page.
 * ----------------------------------------------------------
 * Shows exactly where the training data comes from (the "2 places"):
 *   1. chat exchanges (web / telegram / training chats)
 *   2. research findings auto-saved as knowledge documents
 * plus the trained model size.
 */

export interface DatasetStats {
  conversations: number;
  totalMessages: number;
  userMessages: number;
  aiMessages: number;
  /** user→ai pairs usable as a fine-tuning dataset */
  pairs: number;
  bySource: Record<string, number>;
  knowledgeDocs: number;
  researchFindings: number;
  memoryFacts: number;
  modelChains: number;
  vocabSize: number;
}

export function datasetStats(db: any): DatasetStats {  const num = (sql: string) => Number((db.prepare(sql).get() as any)?.c ?? 0) || 0;
  const messages = db
    .prepare("SELECT role, source, session_id FROM chat_messages ORDER BY id ASC")
    .all() as { role: string; source: string; session_id: number }[];

  const bySource: Record<string, number> = {};
  let pairs = 0;
  for (let i = 0; i < messages.length - 1; i++) {
    if (messages[i].role === "user" && messages[i + 1].role === "ai") pairs++;
  }
  for (const m of messages) {
    const src = m.source || "web";
    bySource[src] = (bySource[src] ?? 0) + 1;
  }

  const model = db.prepare("SELECT value FROM ai_model WHERE key = 'markov'").get() as any;
  let modelChains = 0;
  let vocabSize = 0;
  if (model?.value) {
    try {
      const j = JSON.parse(model.value);
      modelChains = Object.keys(j?.chains ?? {}).length;
      vocabSize = Object.keys(j?.vocab ?? {}).length;
    } catch {
      /* untrained model */
    }
  }

  return {
    conversations: num("SELECT COUNT(*) AS c FROM conversations"),
    totalMessages: messages.length,
    userMessages: messages.filter((m) => m.role === "user").length,
    aiMessages: messages.filter((m) => m.role === "ai").length,
    pairs,
    bySource,
    knowledgeDocs: num("SELECT COUNT(*) AS c FROM knowledge"),
    researchFindings: num("SELECT COUNT(*) AS c FROM knowledge WHERE title LIKE 'Research:%'"),
    memoryFacts: num("SELECT COUNT(*) AS c FROM memory"),
    modelChains,
    vocabSize,
  };
}

/**
 * Fine-tuning dataset export — every user→ai adjacent pair becomes one
 * ShareGPT-style line (the same format train_lora.py / build_dataset.py
 * consume). Returns the rows plus the ready-to-send JSONL body.
 */
export interface DatasetExport {
  rows: number;
  body: string;
}

export function exportDatasetJsonl(db: any): DatasetExport {
  const sessions = db
    .prepare("SELECT DISTINCT session_id FROM chat_messages")
    .all() as { session_id: number }[];
  const lines: string[] = [];
  for (const s of sessions) {
    const msgs = db
      .prepare("SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id ASC")
      .all(s.session_id) as { role: string; content: string }[];
    for (let i = 0; i < msgs.length - 1; i++) {
      if (msgs[i].role === "user" && msgs[i + 1].role === "ai") {
        lines.push(
          JSON.stringify({
            messages: [
              { role: "user", content: msgs[i].content },
              { role: "assistant", content: msgs[i + 1].content },
            ],
          })
        );
      }
    }
  }
  // Always valid JSONL — end with a newline so tools can cat files together.
  return {
    rows: lines.length,
    body: lines.length ? lines.join("\n") + "\n" : "",
  };
}
