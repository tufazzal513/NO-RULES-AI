/**
 * BM25 retrieval — a dependency-free search engine over the user's knowledge
 * documents. This powers the local "RAG" so the AI can answer from your own
 * documents without any external service or vector database.
 */

export interface KnowledgeDoc {
  id: number;
  title: string;
  content: string;
}

function tokenizeLower(text: string): string[] {
  // \p{M} keeps Bengali vowel signs attached to their letters, so "কেন"
  // tokenises as one word instead of splitting into "ক" + "ন".
  return text.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
}

/** Common words that carry little meaning for retrieval. */
export const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "am", "i", "you", "he", "she", "it", "we", "they", "me", "my", "mine",
  "your", "yours", "his", "her", "hers", "its", "our", "ours", "their",
  "theirs", "this", "that", "these", "those", "and", "or", "but", "if",
  "then", "else", "for", "of", "in", "on", "at", "to", "from", "with",
  "without", "about", "do", "does", "did", "have", "has", "had", "will",
  "would", "can", "could", "should", "shall", "may", "might", "must",
  "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
  "not", "no", "yes", "so", "very", "too", "just", "please", "tell",
  "আর", "এবং", "কি", "কী", "আছে", "আমি", "তুমি", "তুই", "সে", "আমরা",
  "তোমার", "আমার", "এর", "থেকে", "হয়", "হবে", "না", "হ্যাঁ", "একটা", "একটি",
]);

/** Keep only meaningful (non-stopword) terms of a query. */
export function meaningfulTerms(text: string): string[] {
  return [...new Set(tokenizeLower(text).filter((t) => !STOPWORDS.has(t)))];
}

export class BM25 {
  private docs: KnowledgeDoc[];
  private k: number;
  private b: number;
  private docFreq = new Map<string, number>();
  private docTerms: Map<string, number>[] = [];
  private docLen: number[] = [];
  private avgdl = 0;
  private N = 0;

  constructor(docs: KnowledgeDoc[], k = 1.5, b = 0.75) {
    this.docs = docs;
    this.k = k;
    this.b = b;
    this.N = docs.length;
    docs.forEach((d) => {
      const terms = tokenizeLower((d.title || "") + " " + (d.content || ""));
      const tf = new Map<string, number>();
      for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
      this.docTerms.push(tf);
      this.docLen.push(terms.length);
      this.avgdl += terms.length;
      for (const t of tf.keys()) this.docFreq.set(t, (this.docFreq.get(t) || 0) + 1);
    });
    this.avgdl = this.N ? this.avgdl / this.N : 0;
  }

  private idf(term: string): number {
    const df = this.docFreq.get(term) || 0;
    return Math.log((this.N - df + 0.5) / (df + 0.5) + 1);
  }

  search(query: string, topK = 3): { doc: KnowledgeDoc; score: number; snippet: string }[] {
    const qTerms = [...new Set(tokenizeLower(query))];
    if (qTerms.length === 0) return [];
    const results: { doc: KnowledgeDoc; score: number; snippet: string }[] = [];
    for (let i = 0; i < this.N; i++) {
      let score = 0;
      const tf = this.docTerms[i];
      const len = this.docLen[i] || 1;
      for (const t of qTerms) {
        const f = tf.get(t) || 0;
        if (f === 0) continue;
        const idf = this.idf(t);
        score += (idf * f * (this.k + 1)) / (f + this.k * (1 - this.b + this.b * (len / this.avgdl)));
      }
      if (score > 0) {
        results.push({ doc: this.docs[i], score, snippet: makeSnippet(this.docs[i].content, qTerms) });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}

function makeSnippet(content: string, terms: string[], maxLen = 260): string {
  const lower = content.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    idx = lower.indexOf(t);
    if (idx >= 0) break;
  }
  if (idx < 0) idx = 0;
  const start = Math.max(0, idx - 40);
  let snippet = content.slice(start, start + maxLen);
  if (start > 0) snippet = "…" + snippet;
  if (content.length > start + maxLen) snippet += "…";
  return snippet;
}
