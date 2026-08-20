/**
 * Rule-based intents + a safe math evaluator.
 * Small, offline, deterministic — no external AI.
 */

// ---------------------------------------------------------------------------
// Safe math evaluator (shunting-yard). Never uses eval().
// ---------------------------------------------------------------------------

type Tok = { t: "num"; v: number } | { t: "op"; v: string } | { t: "lp" } | { t: "rp" };

function tokenizeMath(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[\d.]/.test(c)) {
      let j = i;
      while (j < s.length && /[\d.]/.test(s[j])) j++;
      const num = parseFloat(s.slice(i, j));
      if (Number.isNaN(num)) throw new Error("bad number");
      out.push({ t: "num", v: num });
      i = j;
      continue;
    }
    if ("+-*/%^".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "(") {
      out.push({ t: "lp" });
      i++;
      continue;
    }
    if (c === ")") {
      out.push({ t: "rp" });
      i++;
      continue;
    }
    throw new Error("bad char");
  }
  return out;
}

function precedence(op: string): number {
  if (op === "+" || op === "-") return 1;
  if (op === "*" || op === "/" || op === "%") return 2;
  if (op === "^") return 3;
  return 0;
}

function evaluate(tokens: Tok[]): number | null {
  // Shunting-yard → RPN
  const out: Tok[] = [];
  const ops: Tok[] = [];
  for (const tok of tokens) {
    if (tok.t === "num") out.push(tok);
    else if (tok.t === "op") {
      while (
        ops.length > 0 &&
        ops[ops.length - 1].t === "op" &&
        precedence((ops[ops.length - 1] as { v: string }).v) >= precedence(tok.v)
      ) {
        out.push(ops.pop()!);
      }
      ops.push(tok);
    } else if (tok.t === "lp") ops.push(tok);
    else if (tok.t === "rp") {
      while (ops.length > 0 && ops[ops.length - 1].t !== "lp") out.push(ops.pop()!);
      if (ops.length === 0) return null;
      ops.pop();
    }
  }
  while (ops.length > 0) {
    const o = ops.pop()!;
    if (o.t === "lp") return null;
    out.push(o);
  }

  // Evaluate RPN
  const stack: number[] = [];
  for (const tok of out) {
    if (tok.t === "num") stack.push(tok.v);
    else if (tok.t === "op") {
      if (stack.length < 2) return null;
      const b = stack.pop()!;
      const a = stack.pop()!;
      let r: number;
      switch (tok.v) {
        case "+": r = a + b; break;
        case "-": r = a - b; break;
        case "*": r = a * b; break;
        case "/": if (b === 0) return null; r = a / b; break;
        case "%": if (b === 0) return null; r = a % b; break;
        case "^": r = Math.pow(a, b); break;
        default: return null;
      }
      stack.push(r);
    }
  }
  return stack.length === 1 ? stack[0] : null;
}

export function tryEvaluateMath(input: string): number | null {
  const trimmed = input.trim();
  if (!/^[0-9+\-*/%^().\s]+$/.test(trimmed) || !/\d/.test(trimmed)) return null;
  try {
    const value = evaluate(tokenizeMath(trimmed));
    if (value === null || !Number.isFinite(value)) return null;
    return Math.round(value * 1e10) / 1e10;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

export function detectIntent(input: string): string | null {
  const t = input.toLowerCase().trim();

  if (/^(hi|hello|hey|yo|hola|salam|assalamu|আসসালামু|সালাম|হাই|হ্যালো|নমস্কার|স্লামালিকুম)[\s!.,]*$/.test(t)) {
    return "Hello! 👋 I'm your personal AI. How can I help you today?";
  }
  if (/(kemon acho|how are you|কেমন আছ|কেমন আছো|কেমন আছেন)/.test(t)) {
    return "I'm doing great, thank you for asking! 😊 How can I help you?";
  }
  if (/^(who are you|who r u|tumi ke|কে তুমি|তুমি কে)/.test(t)) {
    return "I'm MY-AI — your own self-hosted personal AI. Everything I know comes from the data and documents you give me. Nothing leaves your machine except what you choose to store in your Telegram cloud database.";
  }
  if (/(what can you do|help|সাহায্য|কি কি পার|কী কী পার)/.test(t)) {
    return (
      "I can do quite a lot:\n" +
      "• Answer from your knowledge documents 📚\n" +
      "• Remember facts about you 🧠\n" +
      "• Solve math ➗\n" +
      "• Research current questions online — free, no API key 🔎\n" +
      "• Generate text in your own style ✍️\n" +
      "• Keep everything in your Telegram cloud database ☁️\n\n" +
      "Add documents in the 'AI Brain' tab, then ask me about them."
    );
  }
  if (/(thank|thanks|thank you|ধন্যবাদ|শুকরিয়া|dhonnobad)/.test(t)) {
    return "You're most welcome! 😊";
  }
  if (/(what time|koyta baje|কয়টা বাজে|সময়|time)/.test(t) && !/\d/.test(t)) {
    const now = new Date();
    const time = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const date = now.toDateString();
    return `Current time: ${time}\nToday is ${date}.`;
  }
  if (/(aj koto tarikh|আজ কত তারিখ|what.*date|today)/.test(t)) {
    return "Today is " + new Date().toDateString() + ".";
  }
  return null;
}
