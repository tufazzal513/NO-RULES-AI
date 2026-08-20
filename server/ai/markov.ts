/**
 * MarkovModel — a tiny, self-contained text model.
 * -------------------------------------------------
 * Trains an n-gram (order-2, with backoff) model on the user's OWN messages
 * and can generate new text in that style. This is a real, local, offline
 * "brain" — no external API, nothing leaves the machine.
 *
 * It is the *small* brain used for instant, offline generation. The *big*
 * brain (a real neural network) is trained separately via training/train_lora.py
 * on a GPU machine / Colab.
 */

export const END = "\u0001";

/** Unicode-aware tokenizer: keeps words (Bangla/English/numbers) and punctuation separate. */
export function tokenize(text: string): string[] {
  return (
    text
      .replace(/[“”]/g, '"')
      .match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]+/gu)
      ?.filter((t) => t.trim().length > 0) ?? []
  );
}

function isSentenceEnd(token: string): boolean {
  return /^[.!?।॥]+$/.test(token);
}

export interface MarkovJSON {
  order: number;
  chains: Record<string, Record<string, number>>;
  starters: string[];
}

export class MarkovModel {
  order = 2;
  private chains = new Map<string, Map<string, number>>();
  private starters: string[] = [];
  trained = false;

  reset(): void {
    this.chains.clear();
    this.starters = [];
    this.trained = false;
  }

  /** Learn from a block of text (one user message). */
  train(text: string): void {
    const tokens = tokenize(text);
    if (tokens.length === 0) return;

    // The beginning of the text is a starter.
    if (tokens.length >= this.order) {
      this.starters.push(tokens.slice(0, this.order).join(" "));
    }

    for (let i = 0; i < tokens.length; i++) {
      // After sentence-ending punctuation, the next token begins a sentence.
      if (i > 0 && isSentenceEnd(tokens[i - 1]) && tokens.length - i >= this.order) {
        this.starters.push(tokens.slice(i, i + this.order).join(" "));
      }
      const ctx = tokens.slice(Math.max(0, i - this.order), i).join(" ");
      const next = tokens[i];
      let map = this.chains.get(ctx);
      if (!map) {
        map = new Map();
        this.chains.set(ctx, map);
      }
      map.set(next, (map.get(next) || 0) + 1);
    }
    this.trained = this.chains.size > 0;
  }

  private pickStarter(): string[] {
    if (this.starters.length > 0) {
      const s = this.starters[Math.floor(Math.random() * this.starters.length)];
      return s.split(" ");
    }
    const first = this.chains.keys().next().value as string | undefined;
    return first ? first.split(" ").filter(Boolean) : [];
  }

  /** Weighted-random next word with n-gram backoff. */
  private nextWord(ctx: string[]): string | null {
    for (let n = ctx.length; n >= 0; n--) {
      const key = ctx.slice(ctx.length - n).join(" ");
      const map = this.chains.get(key);
      if (map && map.size > 0) {
        let total = 0;
        for (const c of map.values()) total += c;
        let r = Math.random() * total;
        for (const [word, count] of map) {
          r -= count;
          if (r <= 0) return word;
        }
        return map.keys().next().value ?? null;
      }
    }
    return null;
  }

  generate(maxWords = 60): string {
    if (!this.trained) return "";
    const ctx = this.pickStarter();
    if (ctx.length === 0) return "";
    const words = [...ctx];
    while (words.length < maxWords) {
      const next = this.nextWord(words);
      if (next === null || next === END) break;
      words.push(next);
      if (isSentenceEnd(next) && words.length >= 6) break;
    }
    return words
      .join(" ")
      .replace(/\s+([.,!?;:।॥])/g, "$1")
      .trim();
  }

  toJSON(): MarkovJSON {
    const chains: Record<string, Record<string, number>> = {};
    for (const [k, v] of this.chains) {
      chains[k] = Object.fromEntries(v);
    }
    return { order: this.order, chains, starters: [...this.starters] };
  }

  fromJSON(json: MarkovJSON): void {
    this.order = json.order || 2;
    this.chains.clear();
    for (const [k, v] of Object.entries(json.chains || {})) {
      this.chains.set(k, new Map(Object.entries(v)));
    }
    this.starters = json.starters || [];
    this.trained = this.chains.size > 0;
  }

  get size(): number {
    return this.chains.size;
  }

  get vocabSize(): number {
    const s = new Set<string>();
    for (const map of this.chains.values()) for (const w of map.keys()) s.add(w);
    return s.size;
  }
}
