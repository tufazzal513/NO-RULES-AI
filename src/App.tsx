/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * MY-AI control panel — Gemini-style chat interface (light theme).
 * -----------------------------------------------------------------
 * The whole app is styled after the Gemini web chat: white canvas,
 * #1e1f20 sidebar with "New chat" pill + recent chats, centered
 * conversation column, suggestion cards, pill-shaped composer and
 * the sparkle avatar for AI replies.
 */

import { useEffect, useRef, useState } from "react";
import {
  Menu, X, Plus, LayoutDashboard, GraduationCap, Globe, Database, Users,
  Settings, DatabaseBackup, Terminal, Paperclip, Mic, Volume2, Trash2,
  Download, Play, Search, RefreshCw, WifiOff, Copy, BookMarked, ShieldCheck,
  Lock, CheckCircle2, CircleAlert, Clock, ArrowUp, Send, Pencil, Keyboard,
  MessageSquare, Upload, PanelLeft, Activity, ClipboardPaste, Loader2,
  History,
} from "lucide-react";

/* ------------------------------------------------------------------------ */
/* Small shared helpers                                                     */
/* ------------------------------------------------------------------------ */

const ADMIN_TOKEN_KEY = "myai_admin_token";
const TRAINING_SESSION_KEY = "myai_training_session";

let onAuthRequired: (() => void) | null = null;

/** Fetch wrapper: attaches the stored admin token, opens the password modal on 401. */
async function api(path: string, opts: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = { ...((opts.headers as Record<string, string>) ?? {}) };
  const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
  if (token) headers["x-admin-token"] = token;
  const res = await fetch(path, { ...opts, headers });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (res.status === 401 && data?.code === "admin_required") {
    onAuthRequired?.();
    throw new Error("Admin password required");
  }
  if (!res.ok) throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
  return data;
}

/** Gemini's 4-point sparkle in the brand gradient. */
function Sparkle({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <defs>
        <linearGradient id="myai-sparkle" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor="#9168C0" />
          <stop offset="0.5" stopColor="#5684E9" />
          <stop offset="1" stopColor="#4AB7E8" />
        </linearGradient>
      </defs>
      <path
        d="M12 0c0 6.627-5.373 12-12 12 6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12z"
        fill="url(#myai-sparkle)"
      />
    </svg>
  );
}

const modeMeta: Record<string, { icon: string; label: string }> = {
  intent: { icon: "⚙️", label: "Intent" },
  memory: { icon: "🧠", label: "Memory" },
  knowledge: { icon: "📚", label: "Knowledge" },
  research: { icon: "🔎", label: "Research" },
  generate: { icon: "✍️", label: "My Model" },
  fallback: { icon: "✨", label: "Assistant" },
};

const fmtTime = (iso?: string | null) => {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Never";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const rel = mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
  return `${d.toLocaleString()} (${rel})`;
};

const relTime = (iso?: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

/** "2h 14m" / "9m 30s" — for GPU-training ETA and elapsed time. */
const fmtDuration = (seconds?: number | null) => {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

/** Phase → Bangla label + colour, for the GPU-training card. */
const GPU_PHASES: Record<string, { label: string; tone: string }> = {
  starting: { label: "শুরু হচ্ছে", tone: "#fdd663" },
  data: { label: "ডাটা তৈরি", tone: "#fdd663" },
  model: { label: "মডেল লোড", tone: "#fdd663" },
  probe: { label: "স্পিড প্রোব", tone: "#8ab4f8" },
  training: { label: "ট্রেনিং চলছে", tone: "#8ab4f8" },
  "oom-recovery": { label: "OOM রিকভারি", tone: "#f28b82" },
  saving: { label: "সেভ হচ্ছে", tone: "#81c995" },
  export: { label: "GGUF এক্সপোর্ট", tone: "#81c995" },
  testing: { label: "টেস্ট চলছে", tone: "#81c995" },
  done: { label: "শেষ ✅", tone: "#81c995" },
  failed: { label: "ব্যর্থ", tone: "#f28b82" },
};

/** Tiny inline loss curve — no chart library, just an SVG polyline. */
function LossSparkline({ samples }: { samples: { step: number; loss: number | null }[] }) {
  const pts = samples.filter((s) => typeof s.loss === "number" && Number.isFinite(s.loss as number));
  if (pts.length < 2) {
    return <div className="h-14 flex items-center justify-center text-[11px] text-[#9aa0a6]">loss curve আসছে…</div>;
  }
  const losses = pts.map((p) => p.loss as number);
  const min = Math.min(...losses);
  const max = Math.max(...losses);
  const span = max - min || 1;
  const w = 100;
  const h = 100;
  const d = pts
    .map((p, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h - (((p.loss as number) - min) / span) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <div className="relative h-14">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-full">
        <path d={`${d} L${w},${h} L0,${h} Z`} fill="#8ab4f8" opacity="0.12" />
        <path d={d} fill="none" stroke="#8ab4f8" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="absolute top-0 right-0 text-[10px] text-[#9aa0a6]">{max.toFixed(3)}</span>
      <span className="absolute bottom-0 right-0 text-[10px] text-[#81c995]">{min.toFixed(3)}</span>
    </div>
  );
}

/** Friendly labels for the training triggers recorded in the journal. */
const TRAIN_TRIGGERS: Record<string, { label: string; icon: string }> = {
  manual: { label: "Manual", icon: "▶️" },  ingest: { label: "File import", icon: "📂" },
  knowledge: { label: "Knowledge added", icon: "📚" },
  memory: { label: "Memory saved", icon: "🧠" },
  chat: { label: "Chat message", icon: "💬" },
  startup: { label: "Startup", icon: "🚀" },
  automatic: { label: "Automatic", icon: "✨" },
};

/* ------------------------------------------------------------------------ */
/* ChatView — the Gemini-style conversation surface                         */
/* ------------------------------------------------------------------------ */

interface ChatMessage {
  /** Database id — present for messages loaded from / saved to the server. */
  id?: number;
  role: "user" | "ai";
  content: string;
  mode?: string;
}

interface ChatViewProps {
  variant: "main" | "training";
  userName: string;
  messages: ChatMessage[];
  isTyping: boolean;
  input: string;
  setInput: (v: string) => void;
  onSend: (text?: string) => void;
  onSave: (msg: ChatMessage) => void;
  /** Rewrite an already-sent question and answer it again. */
  onEdit?: (msg: ChatMessage, newText: string) => void | Promise<void>;
  /** Remove a message (and its answer) from the conversation. */
  onDelete?: (msg: ChatMessage) => void | Promise<void>;
  /** Ask the same question again for a fresh answer. */
  onRegenerate?: () => void | Promise<void>;
  /** Exposed so ⌘/Ctrl+↑ can start editing the last question from anywhere. */
  editingId?: number | null;
  setEditingId?: (id: number | null) => void;
}

const MAIN_SUGGESTIONS = [
  "🔎 সর্বশেষ খবর কী?",
  "কেন আকাশ নীল?",
  "আমার নাম কী?",
  "➗ 12 * 8 + 4 কত হয়?",
];

const TRAINING_SUGGESTIONS = [
  "আমার নাম কী?",
  "ভাত রান্নার নিয়ম কীভাবে হয়?",
  "Remember that I like tea",
  "2 + 2 * 3",
];

function ChatView({
  variant, userName, messages, isTyping, input, setInput, onSend, onSave,
  onEdit, onDelete, onRegenerate, editingId, setEditingId,
}: ChatViewProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [listening, setListening] = useState(false);
  const [attachMsg, setAttachMsg] = useState("");
  const [editDraft, setEditDraft] = useState("");

  /** Start editing a message that was already sent. */
  const beginEdit = (msg: ChatMessage) => {
    if (!msg.id || !setEditingId) return;
    setEditDraft(msg.content);
    setEditingId(msg.id);
  };

  const cancelEdit = () => {
    setEditingId?.(null);
    setEditDraft("");
  };

  const commitEdit = async (msg: ChatMessage) => {
    const next = editDraft.trim();
    cancelEdit();
    if (!next || next === msg.content) return;
    await onEdit?.(msg, next);
  };

  const micSupported =
    typeof window !== "undefined" &&
    Boolean((window as any).webkitSpeechRecognition || (window as any).SpeechRecognition);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  };

  const startMic = () => {
    const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
    if (!SR) return;
    try {
      const rec = new SR();
      rec.lang = "bn-BD";
      rec.interimResults = true;
      rec.onresult = (e: any) => {
        const text = Array.from(e.results)
          .map((r: any) => r[0].transcript)
          .join(" ");
        setInput(text);
      };
      rec.onend = () => setListening(false);
      rec.onerror = () => setListening(false);
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  };

  const onFile = async (f: File) => {
    if (!f) return;
    setAttachMsg(`Adding "${f.name}" to knowledge…`);
    try {
      const text = await f.text();
      if (!text.trim()) throw new Error("File is empty");
      if (text.length > 400_000) throw new Error("File too large (max ~400 KB)");
      await api("/api/v1/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: f.name, content: text.trim() }),
      });
      setAttachMsg(`"${f.name}" saved as a knowledge document 📚`);
      setTimeout(() => setAttachMsg(""), 4000);
    } catch (e: any) {
      setAttachMsg("⚠️ " + e.message);
      setTimeout(() => setAttachMsg(""), 5000);
    }
  };

  const showSuggestions = messages.length <= 1 && !isTyping;
  const suggestions = variant === "training" ? TRAINING_SUGGESTIONS : MAIN_SUGGESTIONS;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[800px] mx-auto px-4 md:px-6 py-6 space-y-6">
          {messages.map((msg, idx) => (
            <div key={idx} className={`group flex gap-3 md:gap-4 ${msg.role === "user" ? "justify-end" : ""}`}>
              {msg.role === "ai" ? (
                <div className="w-8 h-8 shrink-0 mt-0.5 rounded-full bg-[#1e1f20] flex items-center justify-center">
                  <Sparkle size={18} />
                </div>
              ) : (
                <div className="w-8 h-8 shrink-0 mt-0.5 rounded-full bg-[#4E7DF5] text-white flex items-center justify-center text-sm font-medium">
                  {userName.slice(0, 1).toUpperCase() || "Y"}
                </div>
              )}
              <div className={`min-w-0 ${msg.role === "user" ? "max-w-[85%] md:max-w-[75%]" : "flex-1 max-w-full"}`}>
                {msg.role === "user" ? (
                  editingId && msg.id === editingId ? (
                    /* ---- inline editor for an already-sent question ---- */
                    <div className="bg-[#1e1f20] border-2 border-[#243a5c] rounded-[22px] px-3 py-2.5">
                      <textarea
                        value={editDraft}
                        autoFocus
                        rows={Math.min(8, editDraft.split("\n").length + 1)}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void commitEdit(msg);
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            cancelEdit();
                          }
                        }}
                        className="w-full bg-transparent resize-none outline-none text-[15px] leading-relaxed text-[#e8eaed]"
                      />
                      <div className="flex items-center justify-end gap-2 mt-1.5">
                        <span className="mr-auto text-[10px] text-[#9aa0a6]">Enter দিয়ে save · Esc দিয়ে cancel</span>
                        <button
                          onClick={cancelEdit}
                          className="px-3 py-1.5 text-[12px] rounded-full bg-[#1e1f20] hover:bg-[#282a2c] transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => void commitEdit(msg)}
                          className="px-3 py-1.5 text-[12px] rounded-full bg-[#e8eaed] text-[#131314] hover:bg-[#ffffff] transition-colors"
                        >
                          Save & rerun
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-end">
                      <div className="bg-[#282a2c] text-[#e8eaed] px-4 py-2.5 rounded-[22px] leading-relaxed whitespace-pre-wrap text-[15px]">
                        {msg.content}
                      </div>
                      <div className="mt-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        {msg.id && onEdit && (
                          <button
                            onClick={() => beginEdit(msg)}
                            title="Edit this message (⌘/Ctrl + ↑ for the last one)"
                            className="p-1.5 text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#1e1f20] rounded-full transition-colors"
                          >
                            <Pencil size={14} />
                          </button>
                        )}
                        <button
                          onClick={() => navigator.clipboard?.writeText(msg.content)}
                          title="Copy"
                          className="p-1.5 text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#1e1f20] rounded-full transition-colors"
                        >
                          <Copy size={14} />
                        </button>
                        {msg.id && onDelete && (
                          <button
                            onClick={() => void onDelete(msg)}
                            title="Delete this message and its answer"
                            className="p-1.5 text-[#9aa0a6] hover:text-[#f28b82] hover:bg-[#3c2424] rounded-full transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                ) : (
                  <div>
                    <div className="text-sm leading-relaxed whitespace-pre-wrap text-[#e8eaed]">{msg.content}</div>
                    <div className="mt-1.5 flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                      {msg.mode && modeMeta[msg.mode] && (
                        <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-[#9aa0a6] bg-[#1e1f20] border border-[#3c4043] px-2 py-0.5 rounded-full">
                          {modeMeta[msg.mode].icon} {modeMeta[msg.mode].label}
                        </span>
                      )}
                      <button
                        onClick={() => navigator.clipboard?.writeText(msg.content)}
                        title="Copy"
                        className="p-1.5 text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#1e1f20] rounded-full transition-colors"
                      >
                        <Copy size={15} />
                      </button>
                      <button
                        onClick={() => {
                          if (idx === messages.length - 1 && onRegenerate) {
                            void onRegenerate();
                            return;
                          }
                          const lastUser = [...messages].reverse().find((m) => m.role === "user");
                          if (lastUser) onSend(lastUser.content);
                        }}
                        title="Regenerate this answer"
                        className="p-1.5 text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#1e1f20] rounded-full transition-colors"
                      >
                        <RefreshCw size={15} />
                      </button>
                      <button
                        onClick={() => {
                          window.speechSynthesis?.cancel();
                          const u = new SpeechSynthesisUtterance(msg.content);
                          window.speechSynthesis?.speak(u);
                        }}
                        title="Speak"
                        className="p-1.5 text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#1e1f20] rounded-full transition-colors"
                      >
                        <Volume2 size={15} />
                      </button>
                      <button
                        onClick={() => onSave(msg)}
                        title="Save to knowledge (training data)"
                        className="p-1.5 text-[#9aa0a6] hover:text-[#e8eaed] hover:bg-[#1e1f20] rounded-full transition-colors"
                      >
                        <BookMarked size={15} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}

          {isTyping && (
            <div className="flex gap-3 md:gap-4">
              <div className="w-8 h-8 shrink-0 rounded-full bg-[#1e1f20] flex items-center justify-center">
                <Sparkle size={18} />
              </div>
              <div className="flex-1 pt-1">
                <div className="text-[15px] text-[#e8eaed]">{variant === "training" ? "প্রশিক্ষণ চলছে" : "Thinking"}…</div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#4E7DF5] soft-pulse" />
                  <span className="w-1.5 h-1.5 rounded-full bg-[#4E7DF5] soft-pulse" style={{ animationDelay: "0.2s" }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-[#4E7DF5] soft-pulse" style={{ animationDelay: "0.4s" }} />
                </div>
              </div>
            </div>
          )}

          {showSuggestions && (
            <div className="pt-2 pb-6">
              <div className="grid sm:grid-cols-2 gap-3">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => onSend(s)}
                    className="text-left bg-[#1e1f20] hover:bg-[#282a2c] rounded-2xl px-4 py-3.5 text-[14px] text-[#e8eaed] leading-snug transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      {/* Composer — Gemini-style pill */}
      <div className="shrink-0 bg-gradient-to-t from-[#131314] via-[#131314] to-transparent px-3 pb-3 pt-6">
        <div className="max-w-[800px] mx-auto">
          {attachMsg && (
            <div className="mb-2 text-xs text-[#8ab4f8] bg-[#1a2b45] border border-[#243a5c] rounded-xl px-3 py-2">{attachMsg}</div>
          )}
          <div className="flex items-end gap-1 bg-[#1e1f20] rounded-[28px] px-2 py-2 shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,.json,.csv,.log"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              title="Attach a text file (saved as a knowledge document)"
              className="p-2.5 text-[#c4c7c5] hover:bg-[#282a2c] hover:text-[#e8eaed] rounded-full transition-colors shrink-0"
            >
              <Paperclip size={20} />
            </button>
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autoGrow();
              }}
              onKeyDown={handleKey}
              placeholder={variant === "training" ? "প্রশিক্ষণ চ্যাট — এখানে লিখুন…" : "Message MY-AI…"}
              rows={1}
              className="flex-1 bg-transparent resize-none outline-none text-[15px] leading-6 text-[#e8eaed] placeholder-[#6b7075] py-2 px-1 max-h-40"
            />
            {micSupported && (
              <button
                onClick={startMic}
                title="Voice input"
                className={`p-2.5 rounded-full transition-colors shrink-0 ${listening ? "text-[#8ab4f8] bg-[#243a5c]" : "text-[#c4c7c5] hover:bg-[#282a2c] hover:text-[#e8eaed]"}`}
              >
                <Mic size={20} />
              </button>
            )}
            <button
              onClick={() => onSend()}
              disabled={!input.trim() && !isTyping}
              className={`ml-1 p-2 rounded-full transition-all shrink-0 ${
                input.trim()
                  ? "bg-[#e8eaed] text-[#131314] hover:bg-[#ffffff]"
                  : "bg-[#3c4043] text-[#9aa0a6] cursor-default"
              }`}
            >
              {input.trim() ? <ArrowUp size={20} /> : <Send size={18} />}
            </button>
          </div>
          <div className="text-center mt-2.5 text-[11px] text-[#9aa0a6]">
            MY-AI can make mistakes. Consider verifying important information.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Card — the building block of every admin page (Gemini-ish light card)    */
/* ------------------------------------------------------------------------ */

function Card({ title, icon, children, className = "", right }: { title?: string; icon?: React.ReactNode; children: React.ReactNode; className?: string; right?: React.ReactNode }) {
  return (
    <div className={`bg-[#1e1f20] border border-[#3c4043] rounded-3xl p-4 md:p-5 ${className}`}>
      {title && (
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 text-[13px] font-medium text-[#e8eaed]">
            {icon}
            {title}
          </div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

function StatChip({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-[#282a2c] border border-[#3c4043] rounded-2xl p-3.5">
      <div className="text-[11px] text-[#9aa0a6]">{label}</div>
      <div className="mt-1 text-lg font-medium text-[#e8eaed]">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-[#9aa0a6]">{sub}</div>}
    </div>
  );
}

/** Compact stat used inside cards (GPU training metrics). */
function MiniStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-[#282a2c] border border-[#3c4043] rounded-xl px-3 py-2">
      <div className="text-[10px] text-[#9aa0a6] uppercase tracking-wider">{label}</div>
      <div className="mt-0.5 text-[13px] font-medium text-[#e8eaed] truncate">{value}</div>
    </div>
  );
}

/** Small rounded label for run metadata (GPU name, batch size…). */
function Tag({ children, tone = "#9aa0a6" }: { children: React.ReactNode; tone?: string }) {
  return (
    <span
      className="inline-flex items-center text-[10px] px-2 py-0.5 rounded-full bg-[#282a2c] border border-[#3c4043]"
      style={{ color: tone }}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------------ */
/* App                                                                      */
/* ------------------------------------------------------------------------ */

const NAV_SECTIONS = [
  { name: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
  { name: "training", label: "Training", icon: <GraduationCap size={18} /> },
  { name: "research", label: "Research", icon: <Globe size={18} /> },
  { name: "datasets", label: "Datasets", icon: <Database size={18} /> },
  { name: "users", label: "Users", icon: <Users size={18} /> },
  { name: "telegram", label: "Telegram Cloud", icon: <DatabaseBackup size={18} /> },
  { name: "settings", label: "Settings", icon: <Settings size={18} /> },
  { name: "logs", label: "Activity", icon: <Terminal size={18} /> },
];

export default function App() {
  const [tab, setTab] = useState<string>("chat");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [passwordModal, setPasswordModal] = useState(false);
  const [authStatus, setAuthStatus] = useState<any>({ passwordRequired: false, adminAuthed: false });

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  };

  // ---- dataset export ----
  // Reliable on every browser (incl. Android Chrome): fetch → blob → save.
  // Shows a clear toast on errors or when there is no chat data yet.
  const downloadDataset = async () => {
    showToast("Preparing dataset…");
    try {
      const res = await fetch(`/api/v1/dataset/export?t=${Date.now()}`);
      if (!res.ok) {
        let msg = `Export failed (HTTP ${res.status})`;
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch { /* not json */ }
        showToast(`❌ ${msg}`);
        return;
      }
      const rows = Number(res.headers.get("X-Dataset-Rows") || "-1");
      if (rows === 0) {
        showToast("❌ No chat data yet — chat with your AI first, then export again");
        return;
      }
      const blob = await res.blob();
      if (blob.size === 0) {
        showToast("❌ Export came back empty — chat a bit first, then try again");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "myai-dataset.jsonl";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      showToast(`✅ Downloaded myai-dataset.jsonl (${rows.toLocaleString()} conversations)`);
    } catch (err: any) {
      // Last resort: let the browser handle the URL directly.
      showToast("⚠️ Auto-download blocked — opening directly…");
      window.open(`/api/v1/dataset/export?t=${Date.now()}`, "_blank");
    }
  };

  // ---- health / dashboard ----
  const [health, setHealth] = useState<any>({ status: "Checking…", api: "Checking…", database: "Checking…", model: "Checking…", telegram: "Checking…", stats: {} });
  const fetchHealth = async () => {
    try {
      const d = await api("/api/v1/health/detailed");
      setHealth({ status: d.status, api: d.api, database: d.database, model: d.model, telegram: d.telegram, stats: d.stats || {} });
    } catch {
      /* keep last */
    }
  };

  // ---- main chat ----
  const [sessions, setSessions] = useState<any[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "ai", content: "Hello! 👋 I'm your personal AI — fully yours and offline. Ask me anything, or train me in the Training tab." },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [userName, setUserName] = useState("");

  // ---- chat shortcuts: history search, inline edit, help ----
  const [editingId, setEditingId] = useState<number | null>(null);
  const [lastSent, setLastSent] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const snapshotFileRef = useRef<HTMLInputElement>(null);

  const loadSessions = async () => {
    try {
      const d = await api("/api/v1/chats");
      setSessions(Array.isArray(d) ? d : []);
    } catch {
      /* ignore */
    }
  };

  const newChat = () => {
    setActiveId(null);
    setMessages([{ role: "ai", content: "Hello! 👋 I'm your personal AI — fully yours and offline. Ask me anything, or train me in the Training tab." }]);
  };

  const loadMessages = async (id: number | null) => {
    if (!id) {
      newChat();
      return;
    }
    try {
      const d = await api(`/api/v1/chats/${id}/messages`);
      setMessages(d && d.length ? d : [{ role: "ai", content: "Hello! 👋 I'm your personal AI — fully yours and offline." }]);
    } catch {
      /* ignore */
    }
  };

  // Load the conversation whenever the active session changes.
  useEffect(() => {
    loadMessages(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const sendMain = async (text?: string) => {
    const msg = (text ?? chatInput).trim();
    if (!msg || isTyping) return;
    setChatInput("");
    setLastSent(msg);
    setMessages((prev) => [...prev, { role: "user", content: msg }]);
    setIsTyping(true);
    try {
      const d = await api("/api/v1/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: activeId, message: msg }),
      });
      if (!activeId && d.sessionId) {
        setActiveId(d.sessionId);
        loadSessions();
      }
      setMessages((prev) => [...prev, { role: "ai", content: d.reply, mode: d.mode }]);
      // Pull the saved rows back so every message has its database id — that
      // is what makes "edit / delete this message" possible.
      if (d.sessionId) void refreshMessages(d.sessionId);
      loadSessions();
      refreshBrain();
    } catch (e: any) {
      setMessages((prev) => [...prev, { role: "ai", content: "⚠️ " + e.message }]);
    } finally {
      setIsTyping(false);
    }
  };

  /** Re-read a conversation from the server (ids included). */
  const refreshMessages = async (id: number) => {
    try {
      const d = await api(`/api/v1/chats/${id}/messages`);
      if (Array.isArray(d) && d.length) setMessages(d);
    } catch {
      /* keep what is on screen */
    }
  };

  /** Rewrite an already-sent question and let the AI answer it again. */
  const editMessage = async (msg: ChatMessage, next: string) => {
    if (!activeId || !msg.id) return;
    setIsTyping(true);
    try {
      await api(`/api/v1/chats/${activeId}/messages/${msg.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: next }),
      });
      await refreshMessages(activeId);
      loadSessions();
      showToast("Message edited — নতুন উত্তর তৈরি হলো ✏️");
    } catch (e: any) {
      showToast("⚠️ " + e.message);
    } finally {
      setIsTyping(false);
    }
  };

  /** Delete one message (a question takes its answer with it). */
  const deleteMessage = async (msg: ChatMessage) => {
    if (!activeId || !msg.id) return;
    try {
      await api(`/api/v1/chats/${activeId}/messages/${msg.id}`, { method: "DELETE" });
      await refreshMessages(activeId);
      showToast("Message deleted 🗑️");
    } catch (e: any) {
      showToast("⚠️ " + e.message);
    }
  };

  /** Ask the last question again for a fresh answer. */
  const regenerateLast = async () => {
    if (!activeId || isTyping) return;
    setIsTyping(true);
    try {
      await api(`/api/v1/chats/${activeId}/regenerate`, { method: "POST" });
      await refreshMessages(activeId);
    } catch (e: any) {
      showToast("⚠️ " + e.message);
    } finally {
      setIsTyping(false);
    }
  };

  /** Rename a conversation from the history list. */
  const renameChat = async (id: number, title: string) => {
    const next = title.trim();
    if (!next) return;
    try {
      await api(`/api/v1/chats/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
      loadSessions();
      showToast("Chat renamed ✏️");
    } catch (e: any) {
      showToast("⚠️ " + e.message);
    }
  };

  /** Wipe the entire chat history (knowledge & memory are untouched). */
  const clearAllChats = async () => {
    try {
      const d = await api("/api/v1/chats", { method: "DELETE" });
      newChat();
      loadSessions();
      showToast(`History cleared — ${d?.deleted ?? 0}টি চ্যাট মুছে ফেলা হয়েছে 🧹`);
    } catch (e: any) {
      showToast("⚠️ " + e.message);
    }
  };

  const deleteChat = async (id: number) => {
    try {
      await api(`/api/v1/chats/${id}`, { method: "DELETE" });
      if (activeId === id) newChat();
      loadSessions();
      showToast("Chat deleted");
    } catch (e: any) {
      showToast("⚠️ " + e.message);
    }
  };

  // ---- training chat (Training tab) ----
  const [tActiveId, setTActiveId] = useState<number | null>(Number(sessionStorage.getItem(TRAINING_SESSION_KEY)) || null);
  const [tMessages, setTMessages] = useState<ChatMessage[]>([
    { role: "ai", content: "প্রশিক্ষণ চ্যাট — এখানে যা-ই লিখবেন, সব training data হিসেবে save হবে। AI-কে প্রশ্ন করুন, উত্তর দিন, শেখান। ✍️" },
  ]);
  const [tInput, setTInput] = useState("");
  const [tTyping, setTTyping] = useState(false);
  const [tEditingId, setTEditingId] = useState<number | null>(null);

  useEffect(() => {
    if (!tActiveId) return;
    api(`/api/v1/chats/${tActiveId}/messages`)
      .then((d: any[]) => {
        if (d && d.length) setTMessages(d);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tActiveId]);

  const sendTraining = async (text?: string) => {
    const msg = (text ?? tInput).trim();
    if (!msg || tTyping) return;
    setTInput("");
    setTMessages((prev) => [...prev, { role: "user", content: msg }]);
    setTTyping(true);
    try {
      const d = await api("/api/v1/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: tActiveId, message: msg, training: true }),
      });
      if (!tActiveId && d.sessionId) {
        setTActiveId(d.sessionId);
        sessionStorage.setItem(TRAINING_SESSION_KEY, String(d.sessionId));
      }
      setTMessages((prev) => [...prev, { role: "ai", content: d.reply, mode: d.mode }]);
      // Reload with database ids so edit / delete / regenerate work here too.
      if (d.sessionId) void refreshTrainingMessages(d.sessionId);
      refreshBrain();
    } catch (e: any) {
      setTMessages((prev) => [...prev, { role: "ai", content: "⚠️ " + e.message }]);
    } finally {
      setTTyping(false);
    }
  };

  /** Re-read the training conversation from the server (ids included). */
  const refreshTrainingMessages = async (id: number) => {
    try {
      const d = await api(`/api/v1/chats/${id}/messages`);
      if (Array.isArray(d) && d.length) setTMessages(d);
    } catch {
      /* keep what is on screen */
    }
  };

  /** Same "edit a sent question and rerun" shortcut as the main chat. */
  const editTrainingMessage = async (msg: ChatMessage, next: string) => {
    if (!tActiveId || !msg.id) return;
    setTTyping(true);
    try {
      await api(`/api/v1/chats/${tActiveId}/messages/${msg.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: next }),
      });
      await refreshTrainingMessages(tActiveId);
      refreshBrain();
      showToast("Training message edited ✏️");
    } catch (e: any) {
      showToast("⚠️ " + e.message);
    } finally {
      setTTyping(false);
    }
  };

  const deleteTrainingMessage = async (msg: ChatMessage) => {
    if (!tActiveId || !msg.id) return;
    try {
      await api(`/api/v1/chats/${tActiveId}/messages/${msg.id}`, { method: "DELETE" });
      await refreshTrainingMessages(tActiveId);
      refreshBrain();
      showToast("Training message deleted 🗑️");
    } catch (e: any) {
      showToast("⚠️ " + e.message);
    }
  };

  const regenerateTrainingLast = async () => {
    if (!tActiveId || tTyping) return;
    setTTyping(true);
    try {
      await api(`/api/v1/chats/${tActiveId}/regenerate`, { method: "POST" });
      await refreshTrainingMessages(tActiveId);
    } catch (e: any) {
      showToast("⚠️ " + e.message);
    } finally {
      setTTyping(false);
    }
  };

  // ---- AI brain (training) ----
  const [aiStatus, setAiStatus] = useState<any>({});
  const [knowledge, setKnowledge] = useState<any[]>([]);
  const [memory, setMemory] = useState<any[]>([]);
  const [knowTitle, setKnowTitle] = useState("");
  const [knowContent, setKnowContent] = useState("");
  const [memKey, setMemKey] = useState("");
  const [memValue, setMemValue] = useState("");
  const [brainMsg, setBrainMsg] = useState("");
  const ingestRef = useRef<HTMLInputElement>(null);
  const [ingestBusy, setIngestBusy] = useState(false);

  const refreshBrain = async () => {
    try {
      const [s, k, m] = await Promise.all([
        api("/api/v1/ai/status"),
        api("/api/v1/knowledge"),
        api("/api/v1/memory"),
      ]);
      setAiStatus(s);
      setKnowledge(Array.isArray(k) ? k : []);
      setMemory(Array.isArray(m) ? m : []);
      const nameRow = (m as any[]).find((r) => r.key === "name");
      if (nameRow?.value) setUserName(String(nameRow.value).split(" ")[0]);
    } catch {
      /* ignore */
    }
  };

  // ---- background training journal (live view of the AI self-training) ----
  const [training, setTraining] = useState<any>({ running: false, scheduled: false, scheduledInMs: null, progress: 0, phase: null, lastRun: null, runs: [] });
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteContent, setPasteContent] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);

  const fetchTraining = async () => {
    try {
      const d = await api("/api/v1/ai/training");
      setTraining(d ?? {});
      if (d && !d.running && !d.scheduled) refreshBrain();
    } catch {
      /* keep last */
    }
  };

  // Poll the training journal — fast while a run is in flight, slow otherwise.
  useEffect(() => {
    fetchTraining();
    const interval = setInterval(() => {
      fetchTraining();
    }, training.running || training.scheduled ? 500 : 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [training.running, training.scheduled]);

  // ---- GPU training (Colab / Kaggle LoRA fine-tune) — live from far away ----
  const [gpu, setGpu] = useState<any>({ current: null, runs: [] });
  const gpuRunning = !!gpu?.current?.running;

  const fetchGpu = async () => {
    try {
      setGpu((await api("/api/v1/training/gpu")) ?? { current: null, runs: [] });
    } catch {
      /* keep last */
    }
  };

  useEffect(() => {
    fetchGpu();
    const interval = setInterval(fetchGpu, gpuRunning ? 3000 : 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpuRunning]);

  const clearGpuRuns = async () => {
    try {
      await api("/api/v1/training/gpu", { method: "DELETE" });
      await fetchGpu();
      showToast("GPU run history cleared");
    } catch (e: any) {
      showToast("⚠️ " + e.message);
    }
  };

  /** Copy a ready-to-paste Colab cell with this panel's URL + token filled in. */
  const copyColabCell = async () => {
    const token = sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? "";
    const cell = [
      "# MY-AI — এক-ক্লিক GPU ট্রেনিং (Google Colab · T4)",
      "# Runtime → Change runtime type → T4 GPU → Save, তারপর ▶ Run",
      "import urllib.request",
      "url = 'https://raw.githubusercontent.com/tufazzal513/NO-RULES-AI/main/training/colab_one_click.py'",
      "src = urllib.request.urlopen(url).read().decode()",
      `src = src.replace("PANEL_URL      = ''", "PANEL_URL      = ${JSON.stringify(window.location.origin)}")`,
      `src = src.replace("PANEL_TOKEN    = ''", "PANEL_TOKEN    = ${JSON.stringify(token)}")`,
      "exec(compile(src, 'colab_one_click.py', 'exec'))",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(cell);
      showToast("Colab cell কপি হয়েছে — Colab-এ পেস্ট করে Run দিন 🚀");
    } catch {
      showToast("⚠️ কপি করা গেল না — ব্রাউজার ব্লক করেছে");
    }
  };

  /** Push pasted text as training data — same pipeline as a file import. */
  const pushPasteData = async () => {
    const content = pasteContent.trim();
    if (!content || pasteBusy) return;
    setPasteBusy(true);
    setBrainMsg("Pushing text as training data…");
    try {
      const name = pasteTitle.trim() ? `${pasteTitle.trim().slice(0, 60)}.txt` : `pasted-${new Date().toISOString().slice(0, 16)}.txt`;
      const d = await api("/api/v1/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: [{ name, content }] }),
      });
      setPasteTitle("");
      setPasteContent("");
      setBrainMsg(
        `Pushed ✓ — ${d.knowledgeInserted} knowledge chunks + ${d.pairsInserted} Q/A pairs. Background train started ✨`
      );
      refreshBrain();
      loadSessions();
      fetchTraining();
    } catch (e: any) {
      setBrainMsg("Error: " + e.message);
    } finally {
      setPasteBusy(false);
    }
  };

  const ingestFiles = async (list: FileList | File[]) => {
    const files = Array.from(list).slice(0, 40);
    if (files.length === 0) return;
    setIngestBusy(true);
    setBrainMsg(`Importing ${files.length} file(s)…`);
    try {
      const payload = [];
      for (const f of files) {
        const content = await f.text();
        payload.push({ name: f.name, content });
      }
      const d = await api("/api/v1/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: payload }),
      });
      setBrainMsg(
        `Imported ${d.knowledgeInserted} knowledge chunks + ${d.pairsInserted} Q/A pairs. Background train started ✨`
      );
      refreshBrain();
      loadSessions();
      fetchTraining();
    } catch (e: any) {
      setBrainMsg("Error: " + e.message);
    } finally {
      setIngestBusy(false);
    }
  };

  const trainModel = async () => {
    setBrainMsg("Training started — watch the live progress above ⬆️");
    try {
      await api("/api/v1/ai/train", { method: "POST" });
      fetchTraining();
    } catch (e: any) {
      setBrainMsg("Error: " + e.message);
    }
  };

  const addKnowledge = async () => {
    if (!knowContent.trim()) return;
    try {
      await api("/api/v1/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: knowTitle.trim() || "Untitled", content: knowContent.trim() }),
      });
      setKnowTitle("");
      setKnowContent("");
      setBrainMsg("Knowledge added! 📚");
      refreshBrain();
    } catch (e: any) {
      setBrainMsg("Error: " + e.message);
    }
  };

  const deleteKnowledge = async (id: number) => {
    try {
      await api(`/api/v1/knowledge/${id}`, { method: "DELETE" });
      refreshBrain();
    } catch (e: any) {
      showToast("⚠️ " + e.message);
    }
  };

  const addMemory = async () => {
    if (!memKey.trim() || !memValue.trim()) return;
    try {
      await api("/api/v1/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: memKey.trim(), value: memValue.trim() }),
      });
      setMemKey("");
      setMemValue("");
      setBrainMsg("Memory saved! 🧠");
      refreshBrain();
    } catch (e: any) {
      setBrainMsg("Error: " + e.message);
    }
  };

  const deleteMemory = async (id: number) => {
    try {
      await api(`/api/v1/memory/${id}`, { method: "DELETE" });
      refreshBrain();
    } catch (e: any) {
      showToast("⚠️ " + e.message);
    }
  };

  const saveChatToKnowledge = async (msg: ChatMessage, fromTraining: boolean) => {
    try {
      const prev = fromTraining ? tMessages : messages;
      const idx = prev.indexOf(msg);
      const question = idx > 0 && prev[idx - 1]?.role === "user" ? prev[idx - 1].content : msg.content;
      await api("/api/v1/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `Chat: ${question.slice(0, 60)}`, content: msg.content }),
      });
      showToast("Saved to knowledge — এটি এখন training data 📚");
      refreshBrain();
    } catch (e: any) {
      showToast("⚠️ " + e.message);
    }
  };

  // ---- research ----
  const [researchStatus, setResearchStatus] = useState<any>(null);
  const [researchTopic, setResearchTopic] = useState("");
  const [researchResult, setResearchResult] = useState<any>(null);
  const [researchBusy, setResearchBusy] = useState(false);
  const [researchMsg, setResearchMsg] = useState("");
  const [selftest, setSelftest] = useState<any>(null);
  const [selftestBusy, setSelftestBusy] = useState(false);

  const fetchResearchStatus = async () => {
    try {
      setResearchStatus(await api("/api/v1/research/status"));
    } catch {
      /* ignore */
    }
  };

  const runResearch = async () => {
    const topic = researchTopic.trim();
    if (!topic || researchBusy) return;
    setResearchBusy(true);
    setResearchMsg("Searching…");
    setResearchResult(null);
    try {
      const d = await api("/api/v1/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      setResearchResult({ ok: true, data: d });
    } catch (e: any) {
      setResearchResult({ ok: false, message: e.message });
    }
    setResearchBusy(false);
    setResearchMsg("");
    fetchResearchStatus();
  };

  const runSelftest = async () => {
    if (selftestBusy) return;
    setSelftestBusy(true);
    setResearchMsg("Testing every source…");
    try {
      setSelftest(await api("/api/v1/research/selftest"));
      setResearchMsg("");
    } catch (e: any) {
      setResearchMsg(e.message);
    }
    setSelftestBusy(false);
    fetchResearchStatus();
  };

  const resetResearch = async (clearCache: boolean) => {
    try {
      const d = await api("/api/v1/research/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearCache }),
      });
      setResearchMsg(d.message || "Done");
      fetchResearchStatus();
      setTimeout(() => setResearchMsg(""), 5000);
    } catch (e: any) {
      setResearchMsg(e.message);
    }
  };

  // ---- telegram ----
  const [tgStatus, setTgStatus] = useState<any>({ configured: false });
  const [tgActionStatus, setTgActionStatus] = useState("");
  const [tgResult, setTgResult] = useState<any>(null);
  const [tgSnapshots, setTgSnapshots] = useState<any[]>([]);

  const fetchTelegram = async () => {
    try {
      setTgStatus(await api("/api/v1/telegram/status"));
      const s = await api("/api/v1/telegram/snapshots");
      setTgSnapshots(s.snapshots || []);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (tgStatus.state !== "starting" && tgStatus.state !== "restoring") return;
    const t = setInterval(fetchTelegram, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tgStatus.state]);

  const tgAction = async (action: string, body?: any) => {
    setTgActionStatus(`${action}…`);
    setTgResult(null);
    try {
      const d = await api(`/api/v1/telegram/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      setTgResult({ ok: true, message: d.message || "Done", data: d });
      fetchTelegram();
    } catch (e: any) {
      setTgResult({ ok: false, message: e.message });
    }
    setTgActionStatus("");
  };

  /**
   * Restore straight from a snapshot file the user picks on their device —
   * the escape hatch when Telegram itself is the problem (wrong chat id, bot
   * without admin rights, deleted pin). Accepts .json and .json.gz.
   */
  const restoreFromFile = async (file: File) => {
    if (!file) return;
    setTgActionStatus(`restoring from ${file.name}…`);
    setTgResult(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let d: any;
      if (file.name.endsWith(".gz")) {
        // gzip → send as base64 so the server can gunzip it.
        let binary = "";
        for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
        d = await api("/api/v1/telegram/restore/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base64: btoa(binary) }),
        });
      } else {
        const text = new TextDecoder().decode(buf);
        d = await api("/api/v1/telegram/restore/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ snapshot: JSON.parse(text) }),
        });
      }
      setTgResult({ ok: true, message: d.message || "Restored from file", data: d });
      fetchTelegram();
      loadSessions();
      refreshBrain();
      fetchHealth();
    } catch (e: any) {
      setTgResult({ ok: false, message: e.message });
    }
    setTgActionStatus("");
  };

  /** Leave the `restore_failed` dead-end and continue with the local data. */
  const dismissRestoreFailure = async () => {
    try {
      const d = await api("/api/v1/telegram/restore/dismiss", { method: "POST" });
      setTgResult({ ok: true, message: `Continuing with the local database (state: ${d.state}).`, data: d });
      fetchTelegram();
    } catch (e: any) {
      setTgResult({ ok: false, message: e.message });
    }
  };
  const triggerBackup = async () => {
    try {
      const d = await api("/api/v1/backup", { method: "POST" });
      showToast(d.message || "Backup successful!");
    } catch (e: any) {
      showToast("⚠️ " + e.message);
    }
  };

  // ---- other pages ----
  const [settings, setSettings] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [dataset, setDataset] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [userNameIn, setUserNameIn] = useState("");
  const [userEmail, setUserEmail] = useState("");

  const loadPageData = async (t: string) => {
    try {
      if (t === "settings") setSettings(await api("/api/v1/settings"));
      if (t === "logs") setLogs((await api("/api/v1/logs?n=200")).entries || []);
      if (t === "datasets") setDataset(await api("/api/v1/dataset/stats"));
      if (t === "users") setUsers(await api("/api/v1/users"));
      if (t === "telegram") fetchTelegram();
      if (t === "research") fetchResearchStatus();
      if (t === "training") refreshBrain();
      if (t === "dashboard") fetchHealth();
    } catch {
      /* ignore */
    }
  };

  const addUser = async () => {
    if (!userNameIn.trim() || !userEmail.trim()) return;
    try {
      await api("/api/v1/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: userNameIn.trim(), email: userEmail.trim() }),
      });
      setUserNameIn("");
      setUserEmail("");
      loadPageData("users");
      showToast("User added");
    } catch (e: any) {
      showToast("⚠️ " + e.message);
    }
  };

  const deleteUser = async (id: number) => {
    try {
      await api(`/api/v1/users/${id}`, { method: "DELETE" });
      loadPageData("users");
      showToast("User deleted");
    } catch (e: any) {
      showToast("⚠️ " + e.message);
    }
  };

  // ---- auth ----
  const fetchAuth = async () => {
    try {
      setAuthStatus(await api("/api/v1/auth/status"));
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    onAuthRequired = () => {
      setAuthStatus((a: any) => ({ ...a, adminAuthed: false }));
      setPasswordModal(true);
    };
    return () => {
      onAuthRequired = null;
    };
  }, []);

  const [pwValue, setPwValue] = useState("");
  const [pwError, setPwError] = useState("");

  const verifyPassword = async () => {
    setPwError("");
    try {
      const res = await fetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwValue }),
      });
      const d = await res.json();
      if (!res.ok) {
        setPwError(d.error || "Wrong password");
        return;
      }
      sessionStorage.setItem(ADMIN_TOKEN_KEY, pwValue);
      setPwValue("");
      setPasswordModal(false);
      fetchAuth();
      showToast("Admin unlocked 🔓");
    } catch (e: any) {
      setPwError(e.message);
    }
  };

  // ---- mount ----
  useEffect(() => {
    fetchAuth();
    fetchHealth();
    refreshBrain();
    fetchTelegram();
    fetchResearchStatus();
    loadSessions();
    const h = setInterval(fetchHealth, 10000);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadPageData(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const selectTab = (t: string) => {
    setTab(t);
    setSidebarOpen(false);
  };

  /* ---------------------------------------------------------------- */
  /* Keyboard shortcuts                                                */
  /* ---------------------------------------------------------------- */

  /** Search across chat titles AND message text (debounced, server-side). */
  useEffect(() => {
    if (!searchOpen) return;
    const q = searchQuery.trim();
    const timer = setTimeout(() => {
      api(`/api/v1/chats?limit=50${q ? `&q=${encodeURIComponent(q)}` : ""}`)
        .then((d: any[]) => setSearchResults(Array.isArray(d) ? d : []))
        .catch(() => setSearchResults([]));
    }, 180);
    return () => clearTimeout(timer);
  }, [searchQuery, searchOpen]);

  /** Open a chat from the search palette. */
  const openChat = (id: number) => {
    setActiveId(id);
    selectTab("chat");
    setSearchOpen(false);
    setSearchQuery("");
  };

  /** Put the last question back into the composer for a quick redo. */
  const editLastQuestion = () => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    if (lastUser.id) {
      setEditingId(lastUser.id);
      return;
    }
    setChatInput(lastUser.content || lastSent);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement | null;
      const typing =
        !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      // Esc closes whatever is open (modal → edit → search).
      if (e.key === "Escape") {
        if (shortcutsOpen) return setShortcutsOpen(false);
        if (confirmClear) return setConfirmClear(false);
        if (searchOpen) return setSearchOpen(false);
        if (renamingId !== null) return setRenamingId(null);
        if (editingId !== null) return setEditingId(null);
        return;
      }

      if (!mod) {
        // ↑ on an empty composer edits the previous question (shell-style).
        if (e.key === "ArrowUp" && tab === "chat" && !chatInput.trim() && !typing) {
          e.preventDefault();
          editLastQuestion();
        }
        return;
      }

      // ⌘/Ctrl + K — search chat history
      if (e.key.toLowerCase() === "k" && !e.shiftKey) {
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }
      // ⌘/Ctrl + / — shortcut cheat sheet
      if (e.key === "/") {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      // ⌘/Ctrl + B — collapse / expand the sidebar (mobile drawer)
      if (e.key.toLowerCase() === "b" && !e.shiftKey) {
        e.preventDefault();
        setSidebarOpen((v) => !v);
        return;
      }
      // ⌘/Ctrl + Shift + O — brand new chat
      if (e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        newChat();
        selectTab("chat");
        return;
      }
      // ⌘/Ctrl + Shift + Backspace/Delete — delete the open chat
      if (e.shiftKey && (e.key === "Backspace" || e.key === "Delete")) {
        e.preventDefault();
        if (activeId && confirm("Delete this chat and all its messages?")) deleteChat(activeId);
        return;
      }
      // ⌘/Ctrl + ↑ — edit the last question
      if (e.key === "ArrowUp") {
        e.preventDefault();
        editLastQuestion();
        return;
      }
      // ⌘/Ctrl + Shift + R — regenerate the last answer
      if (e.shiftKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        void regenerateLast();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, chatInput, messages, activeId, searchOpen, shortcutsOpen, editingId, renamingId, confirmClear, isTyping]);

  const authed = !authStatus.passwordRequired || authStatus.adminAuthed;

  /* ---------------------------------------------------------------- */
  /* Page renderers                                                    */
  /* ---------------------------------------------------------------- */

  const renderDashboard = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      <StatChip label="API" value={<span className="text-[#81c995]">{health.api}</span>} sub={`Status: ${health.status}`} />
      <StatChip label="Database" value={health.database} sub={health.stats?.totalUsers != null ? `${health.stats.totalUsers} users` : undefined} />
      <StatChip label="Active Model" value={health.model} sub={aiStatus.trained ? `Trained · ${aiStatus.modelChains ?? 0} chains` : "Not trained yet"} />
      <StatChip label="Telegram Storage" value={health.telegram} sub={tgStatus.botUsername ? `@${tgStatus.botUsername}` : "Backups via Telegram"} />

      {gpu?.current && (
        <Card title="GPU fine-tune (Colab / Kaggle)" icon={<Sparkle size={16} />} className="md:col-span-2 xl:col-span-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="text-[13px] text-[#e8eaed] min-w-0 truncate">
              {(GPU_PHASES[gpu.current.phase]?.label ?? gpu.current.phase)}
              {gpu.current.totalSteps > 0 && <span className="text-[#9aa0a6]"> · step {gpu.current.step}/{gpu.current.totalSteps}</span>}
              {gpu.current.etaSeconds !== null && <span className="text-[#9aa0a6]"> · ETA {fmtDuration(gpu.current.etaSeconds)}</span>}
            </div>
            <button onClick={() => selectTab("training")} className="shrink-0 text-[12px] text-[#8ab4f8] hover:underline">
              বিস্তারিত →
            </button>
          </div>
          <div className="h-2 rounded-full bg-[#282a2c] overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${gpu.current.running ? "train-stripe" : ""}`}
              style={{ width: `${gpu.current.progress}%`, background: GPU_PHASES[gpu.current.phase]?.tone ?? "#8ab4f8" }}
            />
          </div>
        </Card>
      )}

      <Card title="System metrics" icon={<LayoutDashboard size={16} className="text-[#8ab4f8]" />} className="md:col-span-2 xl:col-span-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatChip label="Total Users" value={health.stats?.totalUsers ?? "…"} />
          <StatChip label="Conversations" value={health.stats?.totalConversations ?? "…"} />
          <StatChip label="Messages" value={health.stats?.totalMessages ?? "…"} />
          <StatChip label="Knowledge Docs" value={health.stats?.knowledgeDocs ?? "…"} />
        </div>
      </Card>

      <Card title="Quick actions" icon={<ShieldCheck size={16} className="text-[#81c995]" />}>
        <div className="space-y-2.5">
          <button onClick={triggerBackup} className="w-full py-2.5 bg-[#173f2a] hover:bg-[#21563a] text-[#81c995] rounded-xl text-[13px] font-medium transition-colors">
            💾 Backup DB to Telegram
          </button>
          <button
            onClick={() => tgAction("snapshot", { force: true })}
            className="w-full py-2.5 bg-[#1a2b45] hover:bg-[#243a5c] text-[#8ab4f8] rounded-xl text-[13px] font-medium transition-colors"
          >
            📦 Snapshot Now
          </button>
          <button
            onClick={() => api("/api/v1/users/seed", { method: "POST" }).then(() => { fetchHealth(); showToast("Test user created"); }).catch((e) => showToast("⚠️ " + e.message))}
            className="w-full py-2.5 bg-[#3c2f14] hover:bg-[#4a3a18] text-[#fdd663] rounded-xl text-[13px] font-medium transition-colors"
          >
            🌱 Seed Test User
          </button>
          <button onClick={() => selectTab("training")} className="w-full py-2.5 bg-[#1e1f20] hover:bg-[#282a2c] text-[#e8eaed] border border-[#3c4043] rounded-xl text-[13px] font-medium transition-colors">
            🎓 Open Training
          </button>
        </div>
      </Card>
    </div>
  );

  const renderResearch = () => {
    const sources = (researchStatus?.sources ?? []) as any[];
    const readyCount = sources.filter((s: any) => s.ready).length;
    const cache = researchStatus?.cache ?? {};
    const fmtCooldown = (ms: number) => (ms >= 120000 ? `${Math.ceil(ms / 60000)}m` : `${Math.ceil(ms / 1000)}s`);
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatChip label="Sources ready" value={`${readyCount}/${sources.length || "…"}`} sub="Keyless public sources" />
        <StatChip label="Permanent cache" value={cache.entries ?? "…"} sub={`hits ${cache.hits ?? 0} · stale ${cache.staleServed ?? 0}`} />
        <StatChip label="Negative cache" value={cache.negativeEntries ?? "…"} sub="clean no-answer topics skipped" />
        <StatChip label="Requests / minute" value={researchStatus?.requestsLastMinute ?? "…"} sub={`cap ${researchStatus?.maxRequestsPerMinute ?? 60}`} />

        <Card
          title="Sources & cooldowns"
          icon={<Globe size={16} className="text-[#8ab4f8]" />}
          className="md:col-span-2"
          right={
            <div className="flex items-center gap-1.5">
              <button onClick={runSelftest} disabled={selftestBusy} className="px-3 py-1.5 bg-[#1a73e8] hover:bg-[#2b7de2] disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-1">
                {selftestBusy ? "…" : (<><CheckCircle2 size={12} /> Test all sources</>)}
              </button>
              <button onClick={() => resetResearch(false)} className="px-3 py-1.5 bg-[#1a2b45] hover:bg-[#243a5c] text-[#8ab4f8] rounded-lg text-xs font-medium transition-colors flex items-center gap-1">
                <RefreshCw size={12} /> Reset Cooldowns
              </button>
            </div>
          }
        >
          <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
            {sources.length === 0 && <div className="text-[13px] text-[#9aa0a6] p-4 text-center">Loading source status…</div>}
            {selftest?.sources && (
              <div className="mb-2 p-2.5 bg-[#282a2c] border border-[#3c4043] rounded-xl text-[11px] text-[#9aa0a6]">
                Self-test: {selftest.sources.filter((x: any) => x.pass).length} pass · {selftest.sources.filter((x: any) => !x.pass && !x.skipped).length} fail · {selftest.sources.filter((x: any) => x.skipped).length} skipped
              </div>
            )}
            {sources.map((s: any) => (
              <div key={`${s.name}-${s.host}`} className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl hover:bg-[#282a2c]">
                <div className="min-w-0">
                  <div className="text-[13px] text-[#e8eaed] truncate">{s.name}</div>
                  <div className="text-[11px] text-[#9aa0a6] font-mono truncate">{s.host}</div>
                </div>
                {s.ready ? (
                  <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-[#81c995] bg-[#173f2a] border border-[#21563a] px-2 py-0.5 rounded-full">● Ready</span>
                ) : (
                  <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-[#fdd663] bg-[#3c2f14] border border-[#4a3a18] px-2 py-0.5 rounded-full" title={`${s.failures} failure(s)`}>
                    <WifiOff size={11} /> {fmtCooldown(s.cooldownRemainingMs)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="Try a topic"
          icon={<Search size={16} className="text-[#8ab4f8]" />}
          className="md:col-span-2"
          right={
            <button onClick={() => resetResearch(true)} className="px-3 py-1.5 bg-[#1e1f20] hover:bg-[#282a2c] text-[#e8eaed] border border-[#3c4043] rounded-lg text-xs font-medium transition-colors">
              Clear Cache
            </button>
          }
        >
          <div className="flex gap-2 mb-3">
            <input
              value={researchTopic}
              onChange={(e) => setResearchTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runResearch()}
              placeholder="e.g. latest Bangladesh cricket news"
              className="flex-1 min-w-0 bg-[#282a2c] border border-[#3c4043] focus:border-[#8ab4f8] rounded-xl px-3 py-2.5 text-sm outline-none placeholder:text-[#6b7075]"
            />
            <button onClick={runResearch} disabled={researchBusy} className="px-4 py-2.5 bg-[#1a73e8] hover:bg-[#2b7de2] disabled:opacity-50 text-white rounded-xl text-sm font-medium transition-colors flex items-center gap-1.5 shrink-0">
              {researchBusy ? "…" : (<><Search size={14} /> Search</>)}
            </button>
          </div>
          <div className="text-xs text-[#9aa0a6] mb-3">
            In chat, question-like messages are researched automatically — or type /research &lt;topic&gt;.
            English, বাংলা and Banglish all work: a Banglish question ("Bangladesher rajdhani ki?") is
            transliterated to Bengali before searching, and every hit is scored for relevance so an
            unrelated result is never returned as the answer.
          </div>
          {researchMsg && <div className="text-xs text-[#8ab4f8] p-2.5 bg-[#1a2b45] border border-[#243a5c] rounded-lg mb-3">{researchMsg}</div>}
          {researchResult && (
            <div>
              {researchResult.ok && researchResult.data?.finding && (
                <div className="flex flex-wrap items-center gap-1.5 mb-2">
                  {typeof researchResult.data.finding.confidence === "number" && (
                    <span
                      className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${
                        researchResult.data.finding.confidence >= 0.62
                          ? "bg-[#173f2a] text-[#81c995] border-[#21563a]"
                          : "bg-[#3c2f14] text-[#fdd663] border-[#4a3a18]"
                      }`}
                      title="How well the answer matches the question"
                    >
                      {researchResult.data.finding.confidence >= 0.62 ? <CheckCircle2 size={11} /> : <CircleAlert size={11} />}
                      confidence {Math.round(researchResult.data.finding.confidence * 100)}%
                    </span>
                  )}
                  {researchResult.data.finding.query && (
                    <span className="text-[11px] text-[#9aa0a6] bg-[#1e1f20] border border-[#3c4043] px-2 py-0.5 rounded-full font-mono truncate max-w-full">
                      searched: {researchResult.data.finding.query}
                    </span>
                  )}
                  {(researchResult.data.finding.sourceHosts ?? []).map((h: string) => (
                    <span key={h} className="text-[11px] text-[#9aa0a6] bg-[#1e1f20] border border-[#3c4043] px-2 py-0.5 rounded-full font-mono">
                      {h}
                    </span>
                  ))}
                  {researchResult.data.finding.cached && (
                    <span className="text-[11px] text-[#9aa0a6] bg-[#1e1f20] border border-[#3c4043] px-2 py-0.5 rounded-full">
                      {researchResult.data.finding.stale ? "stale cache" : "cached"}
                    </span>
                  )}
                </div>
              )}
              <div className="p-3.5 bg-[#282a2c] rounded-xl border border-[#3c4043] text-[13px] leading-relaxed text-[#e8eaed] overflow-y-auto max-h-[280px] whitespace-pre-wrap">
                {researchResult.ok ? researchResult.data?.finding?.answer : researchResult.message}
              </div>
              {researchResult.ok && (researchResult.data?.finding?.sources ?? []).length > 0 && (
                <div className="mt-2 space-y-1">
                  {researchResult.data.finding.sources.map((src: any, i: number) => (
                    <a
                      key={i}
                      href={src.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block text-[11px] text-[#8ab4f8] hover:underline truncate"
                    >
                      🔗 {src.title || src.url}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
          {!researchResult && (
            <div className="flex flex-col justify-center items-center text-center text-[#6b7075] py-8">
              <Globe size={26} className="mb-2 opacity-40" />
              <div className="text-xs">17 keyless sources · circuit breakers · negative cache · rate cap</div>
            </div>
          )}
        </Card>
      </div>
    );
  };

  const renderTraining = () => {
    if (authStatus.passwordRequired && !authStatus.adminAuthed) {
      return (
        <div className="max-w-md mx-auto mt-10">
          <Card title="🔒 Admin only" icon={<Lock size={16} className="text-[#fdd663]" />}>
            <p className="text-[13px] text-[#9aa0a6] leading-relaxed mb-4">
              এই ট্যাবে কেবল admin প্রশিক্ষণ দিতে পারেন (ADMIN_PASSWORD চালু আছে)। পাসওয়ার্ড দিয়ে unlock করুন।
            </p>
            <button
              onClick={() => setPasswordModal(true)}
              className="w-full py-2.5 bg-[#1a73e8] hover:bg-[#2b7de2] text-white rounded-xl text-sm font-medium transition-colors"
            >
              Unlock with password
            </button>
          </Card>
        </div>
      );
    }
    const runs = (training?.runs ?? []) as any[];
    const current = training?.currentRun ?? null;
    const progress = Math.max(0, Math.min(100, Number(training?.progress ?? 0)));
    const phase = training?.phase ?? null;
    const running = !!training?.running;
    const scheduled = !!training?.scheduled;
    const phases = (current?.phases?.length ? current.phases : training?.lastRun?.phases ?? []) as any[];

    return (
      <div className="space-y-4">
        {/* ---- GPU training (Colab / Kaggle) — the real LoRA fine-tune ---- */}
        {(() => {
          const g = gpu?.current as any;
          const meta = GPU_PHASES[g?.phase] ?? { label: g?.phase ?? "—", tone: "#9aa0a6" };
          const pill = !g
            ? { text: "No GPU run", bg: "#282a2c", fg: "#9aa0a6", dot: false }
            : g.running
            ? { text: meta.label, bg: "#1a2b45", fg: "#8ab4f8", dot: true }
            : g.stalled
            ? { text: "Stalled — Colab disconnect?", bg: "#3c2f14", fg: "#fdd663", dot: false }
            : g.ok
            ? { text: "শেষ ✅", bg: "#173f2a", fg: "#81c995", dot: false }
            : { text: "ব্যর্থ", bg: "#4a1f1c", fg: "#f28b82", dot: false };
          return (
            <Card
              title="GPU training (Colab / Kaggle) — live"
              icon={<Sparkle size={16} />}
              right={
                <div className="flex items-center gap-2">
                  <span
                    className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full"
                    style={{ background: pill.bg, color: pill.fg }}
                  >
                    {pill.dot && <span className="w-1.5 h-1.5 rounded-full soft-pulse" style={{ background: pill.fg }} />}
                    {pill.text}
                  </span>
                  <button
                    onClick={copyColabCell}
                    className="px-3 py-1.5 bg-[#1a73e8] hover:bg-[#2b7de2] text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                    title="Colab-এ পেস্ট করার জন্য রেডি সেল কপি করুন"
                  >
                    <Copy size={12} /> Copy Colab cell
                  </button>
                  {(gpu?.runs?.length ?? 0) > 0 && (
                    <button
                      onClick={clearGpuRuns}
                      title="Clear GPU run history"
                      className="px-2.5 py-1.5 bg-[#1e1f20] hover:bg-[#282a2c] text-[#e8eaed] border border-[#3c4043] rounded-lg text-xs transition-colors"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              }
            >
              {!g ? (
                <div className="text-[13px] text-[#9aa0a6] leading-relaxed">
                  এখনো কোনো GPU ট্রেনিং রিপোর্ট আসেনি।{" "}
                  <span className="text-[#e8eaed]">“Copy Colab cell”</span> চেপে Colab-এ পেস্ট করে Run দিন —
                  ট্রেনিং শুরু হলেই এখানে step, loss, ETA সব লাইভ দেখতে পাবেন।
                </div>
              ) : (
                <>
                  <div className="flex items-end justify-between mb-1.5 gap-3">
                    <div className="text-[13px] text-[#e8eaed] min-w-0">
                      <span className="font-medium" style={{ color: meta.tone }}>{meta.label}</span>
                      {g.totalSteps > 0 && (
                        <span className="text-[#9aa0a6]"> · step {g.step}/{g.totalSteps}</span>
                      )}
                      {g.loss !== null && <span className="text-[#9aa0a6]"> · loss {Number(g.loss).toFixed(4)}</span>}
                    </div>
                    <div className="text-[12px] text-[#9aa0a6] shrink-0">{g.progress}%</div>
                  </div>
                  <div className="h-2.5 rounded-full bg-[#282a2c] overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${g.running ? "train-stripe" : ""}`}
                      style={{ width: `${g.progress}%`, background: meta.tone }}
                    />
                  </div>

                  <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
                    <MiniStat label="ETA বাকি" value={fmtDuration(g.etaSeconds)} />
                    <MiniStat label="চলছে" value={fmtDuration(g.elapsedSeconds)} />
                    <MiniStat label="Best loss" value={g.bestLoss !== null ? Number(g.bestLoss).toFixed(4) : "—"} />
                    <MiniStat label="সেকেন্ড/step" value={g.secondsPerStep ? `${Number(g.secondsPerStep).toFixed(2)}s` : "—"} />
                  </div>

                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <div className="text-[11px] font-medium text-[#9aa0a6] mb-1 uppercase tracking-wider">Loss curve</div>
                      <LossSparkline samples={g.samples ?? []} />
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {g.gpu && <Tag>{g.gpu}{g.vramGb ? ` · ${g.vramGb}GB` : ""}</Tag>}
                        {g.model && <Tag>{String(g.model).split("/").pop()}</Tag>}
                        {g.batchSize && <Tag>batch {g.batchSize}×{g.gradAccum ?? 1}</Tag>}
                        {g.maxSeqLength && <Tag>seq {g.maxSeqLength}</Tag>}
                        {g.trainRows && <Tag>{g.trainRows} rows</Tag>}
                        {g.oomRetries > 0 && <Tag tone="#f28b82">OOM ×{g.oomRetries}</Tag>}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium text-[#9aa0a6] mb-1 uppercase tracking-wider">Events</div>
                      <div className="space-y-1 max-h-32 overflow-y-auto pr-1">
                        {(g.events ?? []).length === 0 && <div className="text-[11px] text-[#9aa0a6]">No events yet.</div>}
                        {[...(g.events ?? [])].reverse().map((e: any, i: number) => (
                          <div key={i} className="flex items-start gap-2 text-[11px]">
                            <span className="text-[#9aa0a6] shrink-0 font-mono">{new Date(e.at).toLocaleTimeString()}</span>
                            <span className={e.level === "error" ? "text-[#f28b82]" : e.level === "warn" ? "text-[#fdd663]" : "text-[#e8eaed]"}>
                              {e.message}
                            </span>
                          </div>
                        ))}
                      </div>
                      {g.stalled && (
                        <div className="mt-2 text-[11px] text-[#fdd663] bg-[#3c2f14] border border-[#5c4a1e] rounded-lg p-2 leading-relaxed">
                          {fmtDuration(Math.round(g.ageMs / 1000))} ধরে কোনো খবর নেই — Colab ডিসকানেক্ট হয়ে থাকতে পারে।
                          Colab-এ গিয়ে সেলটা আবার Run দিন, শেষ checkpoint থেকেই চালু হবে।
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </Card>
          );
        })()}

        {/* ---- Background training — live view of the AI training itself ---- */}
        <Card
          title="Background training — live"
          icon={<Activity size={16} className="text-[#8ab4f8]" />}
          right={
            <div className="flex items-center gap-2">
              {running ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full bg-[#1a2b45] text-[#8ab4f8]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#8ab4f8] soft-pulse" /> Running
                </span>
              ) : scheduled ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full bg-[#3c2f14] text-[#fdd663]">
                  <Clock size={11} /> Scheduled
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full bg-[#173f2a] text-[#81c995]">
                  <CheckCircle2 size={11} /> Idle
                </span>
              )}
              <button
                onClick={() => void trainModel()}
                disabled={running}
                className="px-3 py-1.5 bg-[#1a73e8] hover:bg-[#2b7de2] disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
              >
                {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Train now
              </button>
            </div>
          }
        >
          <div className="flex items-end justify-between mb-1.5 gap-3">
            <div className="text-[13px] text-[#e8eaed]">
              {running ? (
                <>AI-টা নিজে নিজে background-এ training করছে… <span className="text-[#8ab4f8] font-medium">{phase ?? "working"}</span></>
              ) : scheduled ? (
                <>Training scheduled — {training?.scheduledInMs ?? 0}ms পরে background-এ শুরু হবে…</>
              ) : training?.lastRun ? (
                <>Last run {relTime(training.lastRun.startedAt)} · {training.lastRun.result?.trainedMessages ?? 0} messages → {training.lastRun.result?.modelChains ?? 0} chains</>
              ) : (
                <>এখনো কোনো training run হয়নি — data push করুন বা “Train now” চাপুন।</>
              )}
            </div>
            <div className="text-[12px] text-[#9aa0a6] shrink-0">{progress}%</div>
          </div>
          <div className="h-2.5 rounded-full bg-[#282a2c] overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${running ? "bg-[#8ab4f8] train-stripe" : "bg-[#81c995]"}`}
              style={{ width: `${progress}%` }}
            />
          </div>
          {brainMsg && (
            <div className="mt-3 text-xs text-[#e8eaed] p-2.5 bg-[#282a2c] border border-[#3c4043] rounded-lg">{brainMsg}</div>
          )}

          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="text-[11px] font-medium text-[#9aa0a6] mb-1.5 uppercase tracking-wider">Training steps</div>
              <div className="space-y-1 max-h-32 overflow-y-auto pr-1">
                {phases.length === 0 && <div className="text-[11px] text-[#9aa0a6]">No steps recorded yet.</div>}
                {phases.map((p: any, i: number) => (
                  <div key={i} className="flex items-start gap-2 text-[11px]">
                    <span className="text-[#81c995] mt-px shrink-0">✓</span>
                    <span className="text-[#9aa0a6] shrink-0 font-mono">{p.at ? new Date(p.at).toLocaleTimeString() : ""}</span>
                    <span className="text-[#e8eaed]">{p.name}</span>
                    {p.detail && <span className="text-[#9aa0a6]">— {p.detail}</span>}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-[#9aa0a6] mb-1.5 uppercase tracking-wider flex items-center gap-1"><History size={11} /> Run history</div>
              <div className="space-y-1 max-h-32 overflow-y-auto pr-1">
                {runs.length === 0 && <div className="text-[11px] text-[#9aa0a6]">No runs yet — import data or press “Train now”.</div>}
                {runs.map((r: any) => (
                  <div key={r.id} className="flex items-center gap-2 text-[11px] py-0.5">
                    <span>{TRAIN_TRIGGERS[r.trigger]?.icon ?? "✨"}</span>
                    <span className="text-[#e8eaed]">{TRAIN_TRIGGERS[r.trigger]?.label ?? r.trigger}</span>
                    <span className="text-[#9aa0a6]">→ {r.result?.modelChains ?? 0} chains · {r.result?.vocabSize ?? 0} vocab</span>
                    <span className="ml-auto text-[#9aa0a6] shrink-0">{relTime(r.startedAt)}</span>
                    {r.ok ? <CheckCircle2 size={11} className="text-[#81c995] shrink-0" /> : <CircleAlert size={11} className="text-[#f28b82] shrink-0" />}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        {/* Training chat — chat with the AI right here, admin only */}
        <div className="xl:col-span-3 flex flex-col bg-[#1e1f20] border border-[#3c4043] rounded-3xl overflow-hidden" style={{ minHeight: 560 }}>
          <div className="px-4 md:px-5 py-3 border-b border-[#3c4043] flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <GraduationCap size={16} className="text-[#8ab4f8]" />
              <span className="text-[13px] font-medium">প্রশিক্ষণ চ্যাট — messages are stored as training data</span>
            </div>
            {tActiveId && (
              <button
                onClick={() => {
                  sessionStorage.removeItem(TRAINING_SESSION_KEY);
                  setTActiveId(null);
                  setTMessages([{ role: "ai", content: "প্রশিক্ষণ চ্যাট — এখানে যা-ই লিখবেন, সব training data হিসেবে save হবে। ✍️" }]);
                }}
                className="text-[11px] text-[#9aa0a6] hover:text-[#e8eaed] flex items-center gap-1"
              >
                <Trash2 size={13} /> Reset
              </button>
            )}
          </div>
          <ChatView
            variant="training"
            userName={userName || "Admin"}
            messages={tMessages}
            isTyping={tTyping}
            input={tInput}
            setInput={setTInput}
            onSend={sendTraining}
            onSave={(m) => saveChatToKnowledge(m, true)}
            onEdit={editTrainingMessage}
            onDelete={deleteTrainingMessage}
            onRegenerate={regenerateTrainingLast}
            editingId={tEditingId}
            setEditingId={setTEditingId}
          />
        </div>

        <div className="xl:col-span-2 space-y-4">
          {/* Push training data — file import AND paste-text box */}
          <Card title="Push training data" icon={<ClipboardPaste size={16} className="text-[#c58af9]" />}>
            <input
              ref={ingestRef}
              type="file"
              multiple
              accept=".txt,.md,.jsonl,.ndjson,.json,.csv,text/plain"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) void ingestFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => ingestRef.current?.click()}
              disabled={ingestBusy}
              className="w-full py-2.5 bg-[#3a2550] hover:bg-[#4a3166] disabled:opacity-50 text-[#c58af9] rounded-xl text-[13px] font-medium transition-colors flex items-center justify-center gap-1.5"
            >
              {ingestBusy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} {ingestBusy ? "Importing…" : "Import files (.txt / .md / .jsonl)"}
            </button>
            <p className="mt-1.5 text-[11px] text-[#9aa0a6] leading-snug">
              Other-AI dumps, Bangla/English language files, বা User:/AI: transcripts। Knowledge + Q/A pair হিসেবে save হয়, তারপর background-এ auto-train চলে।
            </p>

            <div className="my-3 flex items-center gap-2 text-[11px] text-[#9aa0a6]">
              <span className="flex-1 h-px bg-[#3c4043]" />
              বা text paste করুন
              <span className="flex-1 h-px bg-[#3c4043]" />
            </div>

            <input
              value={pasteTitle}
              onChange={(e) => setPasteTitle(e.target.value)}
              placeholder="Title (optional)"
              className="w-full bg-[#282a2c] border border-[#3c4043] focus:border-[#8ab4f8] rounded-lg px-3 py-2 text-[13px] outline-none placeholder:text-[#6b7075] mb-2"
            />
            <textarea
              value={pasteContent}
              onChange={(e) => setPasteContent(e.target.value)}
              placeholder={"এখানে যেকোনো text, transcript বা Q/A dialogue paste করুন…\nযেমন:\nUser: amar nam ki?\nAI: Apnar nam Tufazzal."}
              rows={5}
              className="w-full bg-[#282a2c] border border-[#3c4043] focus:border-[#8ab4f8] rounded-lg px-3 py-2 text-[13px] outline-none placeholder:text-[#6b7075] resize-none leading-relaxed"
            />
            <button
              onClick={pushPasteData}
              disabled={pasteBusy || !pasteContent.trim()}
              className="mt-2 w-full py-2.5 bg-[#1a73e8] hover:bg-[#2b7de2] disabled:opacity-50 text-white rounded-xl text-[13px] font-medium transition-colors flex items-center justify-center gap-1.5"
            >
              {pasteBusy ? <Loader2 size={14} className="animate-spin" /> : <ClipboardPaste size={14} />} {pasteBusy ? "Pushing…" : "Push data & auto-train"}
            </button>
          </Card>

          <Card title="Local AI model" icon={<GraduationCap size={16} className="text-[#8ab4f8]" />}>
            <div className="text-xl font-medium text-[#e8eaed]">{aiStatus.trained ? "Trained ✓" : "Not trained yet"}</div>
            <div className="mt-1.5 text-xs text-[#9aa0a6]">
              Messages: {aiStatus.corpusMessages ?? "…"} · Knowledge: {aiStatus.knowledgeDocs ?? "…"} · Memory: {aiStatus.memoryFacts ?? "…"}
              {aiStatus.trained && <> · Chains: {aiStatus.modelChains} · Vocab: {aiStatus.vocabSize}</>}
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={trainModel} className="flex-1 py-2.5 bg-[#1a73e8] hover:bg-[#2b7de2] text-white rounded-xl text-[13px] font-medium transition-colors flex items-center justify-center gap-1.5">
                <Play size={14} /> Train on My Messages
              </button>
              <button onClick={downloadDataset} className="flex-1 py-2.5 bg-[#1a2b45] hover:bg-[#243a5c] text-[#8ab4f8] rounded-xl text-[13px] font-medium transition-colors flex items-center justify-center gap-1.5">
                <Download size={14} /> Export Dataset
              </button>
            </div>
          </Card>

          <Card title="Knowledge 📚" icon={<BookMarked size={16} className="text-[#81c995]" />}>
            <div className="space-y-2 mb-3">
              <input
                value={knowTitle}
                onChange={(e) => setKnowTitle(e.target.value)}
                placeholder="Title"
                className="w-full bg-[#282a2c] border border-[#3c4043] focus:border-[#8ab4f8] rounded-lg px-3 py-2 text-[13px] outline-none placeholder:text-[#6b7075]"
              />
              <textarea
                value={knowContent}
                onChange={(e) => setKnowContent(e.target.value)}
                placeholder="Paste your notes, documents, or anything the AI should know…"
                rows={2}
                className="w-full bg-[#282a2c] border border-[#3c4043] focus:border-[#8ab4f8] rounded-lg px-3 py-2 text-[13px] outline-none placeholder:text-[#6b7075] resize-none"
              />
              <button onClick={addKnowledge} className="w-full py-2 bg-[#173f2a] hover:bg-[#21563a] text-[#81c995] rounded-lg text-[13px] font-medium transition-colors">
                Add Knowledge
              </button>
            </div>
            <div className="space-y-1.5 max-h-44 overflow-y-auto">
              {knowledge.length === 0 && <div className="text-xs text-[#9aa0a6] text-center p-3">No knowledge yet.</div>}
              {knowledge.map((k: any) => (
                <div key={k.id} className="flex justify-between items-start gap-2 px-2.5 py-2 rounded-lg hover:bg-[#282a2c]">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[#e8eaed] truncate">{k.title}</div>
                    <div className="text-[11px] text-[#9aa0a6] truncate">{k.content.slice(0, 70)}</div>
                  </div>
                  <button onClick={() => deleteKnowledge(k.id)} className="p-1 text-[#9aa0a6] hover:text-[#f28b82] shrink-0">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Memory 🧠" icon={<Sparkle size={14} />}>
            <div className="flex gap-2 mb-3">
              <input
                value={memKey}
                onChange={(e) => setMemKey(e.target.value)}
                placeholder="Key"
                className="flex-1 min-w-0 bg-[#282a2c] border border-[#3c4043] focus:border-[#8ab4f8] rounded-lg px-3 py-2 text-[13px] outline-none placeholder:text-[#6b7075]"
              />
              <input
                value={memValue}
                onChange={(e) => setMemValue(e.target.value)}
                placeholder="Value"
                className="flex-1 min-w-0 bg-[#282a2c] border border-[#3c4043] focus:border-[#8ab4f8] rounded-lg px-3 py-2 text-[13px] outline-none placeholder:text-[#6b7075]"
              />
              <button onClick={addMemory} className="px-3 py-2 bg-[#1a2b45] hover:bg-[#243a5c] text-[#8ab4f8] rounded-lg text-[13px] font-medium shrink-0">
                Save
              </button>
            </div>
            <div className="space-y-1.5 max-h-44 overflow-y-auto">
              {memory.length === 0 && <div className="text-xs text-[#9aa0a6] text-center p-3">No memories yet — try "My name is …" in chat.</div>}
              {memory.map((m: any) => (
                <div key={m.id} className="flex justify-between items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-[#282a2c]">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[#e8eaed] truncate">{m.key}</div>
                    <div className="text-[11px] text-[#9aa0a6] truncate">{m.value}</div>
                  </div>
                  <button onClick={() => deleteMemory(m.id)} className="p-1 text-[#9aa0a6] hover:text-[#f28b82] shrink-0">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </Card>
          </div>
        </div>
      </div>
    );
  };

  const renderDatasets = () => (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <StatChip label="Conversations" value={dataset?.conversations ?? "…"} />
      <StatChip label="Messages" value={dataset?.totalMessages ?? "…"} sub={`${dataset?.userMessages ?? 0} user · ${dataset?.aiMessages ?? 0} AI`} />
      <StatChip label="Training pairs" value={dataset?.pairs ?? "…"} sub="user → ai (JSONL ready)" />

      <Card title="Where training data comes from (2 places)" icon={<Database size={16} className="text-[#8ab4f8]" />} className="md:col-span-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-[#282a2c] border border-[#3c4043] rounded-2xl p-3.5">
            <div className="text-[11px] text-[#9aa0a6] mb-1">১. Chat messages</div>
            <div className="flex flex-wrap gap-1.5">
              {(Object.entries(dataset?.bySource ?? {}) as [string, number][]).map(([s, n]) => (
                <span key={s} className="text-[11px] bg-[#1e1f20] border border-[#3c4043] px-2 py-0.5 rounded-full">
                  {s}: {n}
                </span>
              ))}
            </div>
          </div>
          <div className="bg-[#282a2c] border border-[#3c4043] rounded-2xl p-3.5">
            <div className="text-[11px] text-[#9aa0a6] mb-1">২. Research findings → knowledge</div>
            <div className="text-sm text-[#e8eaed]">
              {dataset?.researchFindings ?? "…"} <span className="text-[11px] text-[#9aa0a6]">of {dataset?.knowledgeDocs ?? "…"} docs</span>
            </div>
          </div>
          <div className="bg-[#282a2c] border border-[#3c4043] rounded-2xl p-3.5">
            <div className="text-[11px] text-[#9aa0a6] mb-1">Trained model</div>
            <div className="text-sm text-[#e8eaed]">{dataset?.modelChains ?? 0} chains · {dataset?.vocabSize ?? 0} vocab</div>
          </div>
        </div>
      </Card>

      <Card
        title="Conversations"
        icon={<Database size={16} className="text-[#8ab4f8]" />}
        className="md:col-span-3"
        right={
          <button onClick={downloadDataset} className="px-3 py-1.5 bg-[#1a2b45] hover:bg-[#243a5c] text-[#8ab4f8] rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5">
            <Download size={13} /> Export JSONL
          </button>
        }
      >
        <div className="space-y-1 max-h-96 overflow-y-auto">
          {sessions.length === 0 && <div className="text-[13px] text-[#9aa0a6] p-4 text-center">No conversations yet.</div>}
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl hover:bg-[#282a2c]">
              <div className="min-w-0">
                <div className="text-[13px] text-[#e8eaed] truncate">{s.title || `Chat #${s.id}`}</div>
                <div className="text-[11px] text-[#9aa0a6]">#{s.id} · {s.created_at}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => { setActiveId(s.id); selectTab("chat"); }} className="px-2.5 py-1 text-[11px] bg-[#1e1f20] hover:bg-[#282a2c] rounded-lg transition-colors">
                  Open
                </button>
                <button onClick={() => deleteChat(s.id)} className="p-1.5 text-[#9aa0a6] hover:text-[#f28b82] transition-colors">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );

  const renderUsers = () => (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Card title="Add user" icon={<Users size={16} className="text-[#8ab4f8]" />}>
        <div className="space-y-2">
          <input
            value={userNameIn}
            onChange={(e) => setUserNameIn(e.target.value)}
            placeholder="Name"
            className="w-full bg-[#282a2c] border border-[#3c4043] focus:border-[#8ab4f8] rounded-lg px-3 py-2 text-[13px] outline-none placeholder:text-[#6b7075]"
          />
          <input
            value={userEmail}
            onChange={(e) => setUserEmail(e.target.value)}
            placeholder="Email"
            className="w-full bg-[#282a2c] border border-[#3c4043] focus:border-[#8ab4f8] rounded-lg px-3 py-2 text-[13px] outline-none placeholder:text-[#6b7075]"
          />
          <button onClick={addUser} className="w-full py-2 bg-[#1a73e8] hover:bg-[#2b7de2] text-white rounded-lg text-[13px] font-medium transition-colors">
            Add User
          </button>
        </div>
      </Card>
      <Card title={`All users (${users.length})`} icon={<Users size={16} className="text-[#81c995]" />} className="md:col-span-2">
        <div className="space-y-1.5 max-h-96 overflow-y-auto">
          {users.length === 0 && <div className="text-[13px] text-[#9aa0a6] p-4 text-center">No users yet — add one or seed a test user from the Dashboard.</div>}
          {users.map((u) => (
            <div key={u.id} className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl hover:bg-[#282a2c]">
              <div className="min-w-0">
                <div className="text-[13px] text-[#e8eaed] truncate">{u.name}</div>
                <div className="text-[11px] text-[#9aa0a6] truncate">{u.email} · joined {u.created_at}</div>
              </div>
              <button onClick={() => deleteUser(u.id)} className="p-1.5 text-[#9aa0a6] hover:text-[#f28b82] transition-colors shrink-0">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );

  const renderTelegram = () => {
    const state: string = tgStatus.state || "starting";
    const stateInfo: Record<string, { label: string; cls: string }> = {
      ready: { label: "Ready", cls: "bg-[#173f2a] text-[#81c995] border-[#21563a]" },
      restoring: { label: "Restoring…", cls: "bg-[#3c2f14] text-[#fdd663] border-[#4a3a18]" },
      starting: { label: "Starting…", cls: "bg-[#1a2b45] text-[#8ab4f8] border-[#243a5c]" },
      restore_failed: { label: "Restore Failed", cls: "bg-[#3c2424] text-[#f28b82] border-[#5c3230]" },
    };
    const si = stateInfo[state] || stateInfo.starting;
    const busy = !!tgActionStatus || tgStatus.snapshotInProgress || tgStatus.restoreInProgress;
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Telegram Cloud Database" icon={<DatabaseBackup size={16} className="text-[#fdd663]" />} className="md:col-span-2">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-[13px] font-medium ${si.cls}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${state === "ready" ? "bg-[#81c995]" : "bg-current soft-pulse"}`} />
                {si.label}
              </span>
              <div className="mt-2.5 text-xs text-[#9aa0a6] space-y-0.5">
                <div>Connection: {tgStatus.configured ? "✅ configured" : "❌ not configured"}</div>
                <div>Bot Token: {tgStatus.botTokenSet ? "✅ set" : "❌ missing"} · Channel ID: {tgStatus.chatIdSet ? "✅ set" : "❌ missing"}</div>
                {tgStatus.botUsername && <div>Bot: @{tgStatus.botUsername}</div>}
                {tgStatus.channelTitle && <div>Channel: {tgStatus.channelTitle}</div>}
              </div>
            </div>
            <button onClick={() => tgAction("verify")} className="shrink-0 px-4 py-2.5 bg-[#173f2a] hover:bg-[#21563a] text-[#81c995] rounded-xl text-[13px] font-medium transition-colors">
              Verify Connection
            </button>
          </div>
          {state === "restore_failed" && (
            <div className="mt-3 p-3 bg-[#3c2424] border border-[#5c3230] rounded-xl text-xs text-[#f28b82] break-words">
              ⚠️ Restore failed — local data was NOT modified and the Telegram bot is paused.
              {tgStatus.lastError && <div className="mt-1 font-mono text-[10px] opacity-80">{tgStatus.lastError}</div>}
              <button
                onClick={dismissRestoreFailure}
                className="mt-2.5 px-3 py-1.5 bg-[#282a2c] hover:bg-[#282a2c] text-[#f28b82] border border-[#5c3230] rounded-lg text-[11px] font-medium transition-colors"
              >
                Continue with local data (restart the bot)
              </button>
            </div>
          )}
        </Card>

        <div className="grid grid-cols-2 gap-3 md:col-span-2">
          <StatChip label="Last Backup" value={fmtTime(tgStatus.lastSnapshotAt)} />
          <StatChip label="Last Restore" value={fmtTime(tgStatus.lastRestoreAt)} />
          <StatChip label="Auto Backup" value={tgStatus.autoSnapshotEnabled ? `On · every ${tgStatus.snapshotIntervalMinutes ?? 30} min` : "Off"} sub={`Next: ${fmtTime(tgStatus.nextSnapshotAt)}`} />
          <StatChip label="Auto Restore" value={tgStatus.autoRestoreEnabled ? "On at startup" : "Off"} sub={tgStatus.restoreOnEmptyOnly ? "Only when the local DB is empty" : "Always on startup"} />
        </div>

        <Card title="Cloud actions" icon={<DatabaseBackup size={16} className="text-[#8ab4f8]" />}>
          <div className="space-y-2.5">
            <button onClick={() => tgAction("snapshot", { force: true })} disabled={busy} className="w-full py-2.5 bg-[#1a2b45] hover:bg-[#243a5c] text-[#8ab4f8] rounded-xl text-[13px] font-medium transition-all disabled:opacity-50">
              📦 Backup Now
            </button>
            <button
              onClick={() => {
                if (confirm("Restore the latest Telegram snapshot? This replaces the current local database.")) tgAction("restore", { force: true });
              }}
              disabled={busy}
              className="w-full py-2.5 bg-[#3c2f14] hover:bg-[#4a3a18] text-[#fdd663] rounded-xl text-[13px] font-medium transition-all disabled:opacity-50"
            >
              ♻️ Restore Latest
            </button>
            <button onClick={() => tgAction("sync")} disabled={busy} className="w-full py-2.5 bg-[#1e1f20] hover:bg-[#282a2c] text-[#e8eaed] border border-[#3c4043] rounded-xl text-[13px] font-medium transition-all disabled:opacity-50">
              🔄 Mirror All Records to Telegram
            </button>
            <a href="/api/v1/telegram/snapshot/download" className="block w-full py-2.5 text-center bg-[#1e1f20] hover:bg-[#282a2c] text-[#e8eaed] border border-[#3c4043] rounded-xl text-[13px] font-medium transition-all">
              ⬇️ Download Snapshot (JSON)
            </a>
            <input
              ref={snapshotFileRef}
              type="file"
              accept=".json,.gz,application/json,application/gzip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f && confirm(`Restore the database from "${f.name}"? This replaces the current local data.`)) {
                  void restoreFromFile(f);
                }
                e.target.value = "";
              }}
            />
            <button
              onClick={() => snapshotFileRef.current?.click()}
              disabled={busy}
              className="w-full py-2.5 bg-[#3a2550] hover:bg-[#4a3166] text-[#c58af9] rounded-xl text-[13px] font-medium transition-all disabled:opacity-50"
            >
              ⬆️ Restore from file (.json / .json.gz)
            </button>
            <p className="text-[11px] text-[#9aa0a6] leading-snug pt-1">
              Telegram-এ সমস্যা হলে (ভুল channel id, bot admin নয়, pin মুছে গেছে) — ডাউনলোড করা snapshot ফাইল দিয়েই সব ডেটা ফিরিয়ে আনতে পারবেন।
            </p>
          </div>
          {tgActionStatus && <div className="mt-3 text-center text-xs text-[#9aa0a6] p-2 bg-[#282a2c] rounded-lg">{tgActionStatus}</div>}
          {tgResult && (
            <div className={`mt-3 text-xs p-3 rounded-lg break-words ${tgResult.ok ? "bg-[#173f2a] text-[#81c995] border border-[#21563a]" : "bg-[#3c2424] text-[#f28b82] border border-[#5c3230]"}`}>
              {tgResult.message}
              {tgResult.data?.checksum && <div className="mt-2 font-mono text-[10px] text-[#9aa0a6] break-all">checksum: {tgResult.data.checksum}</div>}
            </div>
          )}
        </Card>

        <Card title={`Snapshots (${tgSnapshots.length})`} icon={<Clock size={16} className="text-[#81c995]" />}>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {tgSnapshots.length === 0 && <div className="text-xs text-[#9aa0a6] text-center p-4">No snapshots yet. Press "Backup Now".</div>}
            {tgSnapshots.map((s: any) => (
              <div key={s.id} className="px-2.5 py-2 rounded-lg hover:bg-[#282a2c]">
                <div className="text-[10px] text-[#9aa0a6] font-mono break-all">{s.telegram_file_id}</div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-[10px] text-[#9aa0a6]">msg {s.telegram_message_id} · {s.created_at}</span>
                  <button
                    onClick={() => tgAction("restore", { fileId: s.telegram_file_id, force: true })}
                    disabled={busy}
                    className="shrink-0 px-2 py-1 text-[10px] bg-[#3c2f14] hover:bg-[#4a3a18] text-[#fdd663] border border-[#4a3a18] rounded-md disabled:opacity-50"
                  >
                    Restore
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    );
  };

  const renderSettings = () => {
    const r = settings?.research ?? {};
    const tg = settings?.telegram ?? {};
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="🔎 Online research" icon={<Globe size={16} className="text-[#8ab4f8]" />} className="md:col-span-2">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            <StatChip label="Enabled" value={r.enabled ? "On" : "Off"} />
            <StatChip label="Cache TTL" value={`${r.cacheTtlMinutes} min`} />
            <StatChip label="Time budget" value={`${r.timeoutMs} ms`} />
            <StatChip label="Save findings → knowledge" value={r.saveToKnowledge ? "On" : "Off"} />
            <StatChip label="Max attempts / call" value={r.maxAttempts ?? 8} />
            <StatChip label="Requests / minute cap" value={r.maxRequestsPerMinute ?? 60} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => resetResearch(false)} className="px-3 py-2 bg-[#1a2b45] hover:bg-[#243a5c] text-[#8ab4f8] rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5">
              <RefreshCw size={13} /> Reset Cooldowns
            </button>
            <button onClick={() => resetResearch(true)} className="px-3 py-2 bg-[#1e1f20] hover:bg-[#282a2c] text-[#e8eaed] border border-[#3c4043] rounded-lg text-xs font-medium transition-colors">
              Clear Research Cache
            </button>
          </div>
        </Card>

        <Card title="☁️ Telegram cloud" icon={<DatabaseBackup size={16} className="text-[#81c995]" />}>
          <div className="space-y-2 text-[13px] text-[#e8eaed]">
            <div className="flex justify-between"><span className="text-[#9aa0a6]">Configured</span><span>{tg.configured ? "✅" : "❌"}</span></div>
            <div className="flex justify-between"><span className="text-[#9aa0a6]">Bot token set</span><span>{tg.botTokenSet ? "✅" : "❌"}</span></div>
            <div className="flex justify-between"><span className="text-[#9aa0a6]">Storage channel set</span><span>{tg.storageChatIdSet ? "✅" : "❌"}</span></div>
            <div className="flex justify-between"><span className="text-[#9aa0a6]">Bot running</span><span>{tg.botRunning ? "✅" : "❌"}</span></div>
            <div className="flex justify-between"><span className="text-[#9aa0a6]">Auto restore</span><span>{tg.autoRestore ? "On" : "Off"}</span></div>
            <div className="flex justify-between"><span className="text-[#9aa0a6]">Auto snapshot</span><span>{tg.autoSnapshot ? `On · ${tg.snapshotIntervalMinutes} min` : "Off"}</span></div>
          </div>
        </Card>

        <Card title="🔐 Admin" icon={<Lock size={16} className="text-[#fdd663]" />}>
          <div className="text-[13px] text-[#e8eaed] leading-relaxed">
            {settings?.adminPasswordRequired ? (
              <>
                <div className="flex items-center gap-2 text-[#81c995] font-medium"><CheckCircle2 size={15} /> Admin password is ON</div>
                <div className="mt-1.5 text-xs text-[#9aa0a6]">
                  Training, Users, Datasets deletion and other write actions require the password. Token: {authStatus.adminAuthed ? "unlocked 🔓" : "locked 🔒"}.
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 font-medium"><CircleAlert size={15} className="text-[#fdd663]" /> Admin password is OFF</div>
                <div className="mt-1.5 text-xs text-[#9aa0a6]">
                  Single-user panel — every action is open. Set <code className="bg-[#1e1f20] px-1 rounded">ADMIN_PASSWORD</code> to lock training &amp; write actions.
                </div>
              </>
            )}
          </div>
        </Card>

        <Card title="🖥️ Runtime" icon={<Settings size={16} className="text-[#9aa0a6]" />} className="md:col-span-2">
          <div className="space-y-1.5 text-xs text-[#9aa0a6]">
            <div>Database: <span className="font-mono text-[#e8eaed] break-all">{settings?.database ?? "…"}</span></div>
            <div>Port: <span className="text-[#e8eaed]">{settings?.port ?? "…"}</span> · Cloud state: <span className="text-[#e8eaed]">{settings?.cloudState ?? "…"}</span></div>
            <div>All values come from environment variables — change them in Render's dashboard (env vars) or <span className="font-mono">.env</span>, then redeploy.</div>
          </div>
        </Card>
      </div>
    );
  };

  const renderLogs = () => {
    const levelCls: Record<string, string> = {
      error: "text-[#f28b82]",
      warn: "text-[#fdd663]",
      info: "text-[#81c995]",
      debug: "text-[#9aa0a6]",
    };
    return (
      <Card
        title="Recent activity"
        icon={<Terminal size={16} className="text-[#8ab4f8]" />}
        right={
          <button onClick={() => loadPageData("logs")} className="px-3 py-1.5 bg-[#1e1f20] hover:bg-[#282a2c] text-[#e8eaed] border border-[#3c4043] rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5">
            <RefreshCw size={13} /> Refresh
          </button>
        }
      >
        <div className="space-y-1 max-h-[70vh] overflow-y-auto font-mono text-[11px]">
          {logs.length === 0 && <div className="text-[#9aa0a6] p-4 text-center">No activity yet.</div>}
          {logs.map((l) => (
            <div key={l.id} className="flex gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[#282a2c] break-all">
              <span className="shrink-0 text-[#9aa0a6]">{new Date(l.at).toLocaleTimeString()}</span>
              <span className={`shrink-0 uppercase w-11 ${levelCls[l.level] ?? ""}`}>{l.level}</span>
              <span className="shrink-0 text-[#8ab4f8]">{l.source}</span>
              <span className="text-[#e8eaed]">{l.message}</span>
            </div>
          ))}
        </div>
      </Card>
    );
  };

  const renderChat = () => (
    <div className="flex flex-col h-full">
      {/* Greeting when a fresh conversation is open */}
      {messages.length <= 1 && !isTyping && (
        <div className="max-w-[800px] w-full mx-auto px-4 md:px-6 pt-10 pb-2 shrink-0">
          <div className="text-[32px] md:text-[40px] font-normal leading-tight">
            <span className="bg-gradient-to-r from-[#9168C0] via-[#4E7DF5] to-[#4AB7E8] bg-clip-text text-transparent">
              Hello, {userName || "there"}
            </span>
          </div>
          <div className="mt-1 text-[#9aa0a6] text-lg">How can I help you today?</div>
        </div>
      )}
      <ChatView
        variant="main"
        userName={userName || "You"}
        messages={messages}
        isTyping={isTyping}
        input={chatInput}
        setInput={setChatInput}
        onSend={sendMain}
        onSave={(m) => saveChatToKnowledge(m, false)}
        onEdit={editMessage}
        onDelete={deleteMessage}
        onRegenerate={regenerateLast}
        editingId={editingId}
        setEditingId={setEditingId}
      />
    </div>
  );

  /* ---------------------------------------------------------------- */
  /* Shell                                                             */
  /* ---------------------------------------------------------------- */

  const tabTitle =
    tab === "chat" ? "MY-AI" : NAV_SECTIONS.find((n) => n.name === tab)?.label ?? "MY-AI";

  return (
    <div className="flex h-screen w-full bg-[#131314] text-[#e8eaed] overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && <div className="fixed inset-0 bg-black/40 z-30 md:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* Sidebar — Gemini style */}
      <aside
        className={`drawer fixed inset-y-0 left-0 z-40 w-[280px] bg-[#1e1f20] flex flex-col md:static md:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="p-4 pb-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 px-1">
              <Sparkle size={22} />
              <span className="text-[18px] font-medium tracking-tight text-[#e8eaed]">MY<span className="text-[#4E7DF5]">-AI</span></span>
            </div>
            <button className="md:hidden p-1.5 text-[#c4c7c5] hover:bg-[#282a2c] hover:text-[#e8eaed] rounded-full" onClick={() => setSidebarOpen(false)}>
              <X size={18} />
            </button>
          </div>

          {/* New chat pill */}
          <button
            onClick={() => {
              newChat();
              selectTab("chat");
            }}
            title="New chat (⌘/Ctrl + Shift + O)"
            className="mt-4 w-full flex items-center gap-2.5 bg-[#394457] hover:bg-[#3c4a63] text-[#e3e9f5] rounded-full px-4 py-2.5 text-[14px] font-medium transition-colors"
          >
            <Plus size={18} strokeWidth={2.5} />
            New chat
          </button>

          {/* Search history */}
          <button
            onClick={() => setSearchOpen(true)}
            title="Search chat history (⌘/Ctrl + K)"
            className="mt-2 w-full flex items-center gap-2.5 text-[#c4c7c5] hover:bg-[#282a2c] hover:text-[#e8eaed] rounded-full px-4 py-2 text-[13px] transition-colors"
          >
            <Search size={16} />
            <span className="flex-1 text-left">Search chats</span>
            <kbd className="text-[10px] text-[#9aa0a6] bg-[#282a2c] border border-[#3c4043] rounded px-1.5 py-0.5">⌘K</kbd>
          </button>
        </div>

        {/* Recent chats */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="flex items-center justify-between px-3 mb-1">
            <span className="text-[12px] font-medium text-[#9aa0a6]">Recent</span>
            {sessions.length > 0 && (
              <button
                onClick={() => setConfirmClear(true)}
                title="Delete all chats"
                className="text-[11px] text-[#9aa0a6] hover:text-[#f28b82] transition-colors"
              >
                Clear all
              </button>
            )}
          </div>
          {sessions.length === 0 && <div className="text-[12px] text-[#9aa0a6] px-3 py-2">No chats yet</div>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`group flex items-center gap-1 rounded-full px-3 py-2 mb-0.5 cursor-pointer transition-colors ${
                tab === "chat" && activeId === s.id ? "bg-[#394457] text-[#e3e9f5]" : "text-[#c4c7c5] hover:bg-[#282a2c] hover:text-[#e8eaed]"
              }`}
              onClick={() => {
                if (renamingId === s.id) return;
                setActiveId(s.id);
                selectTab("chat");
              }}
              onDoubleClick={() => {
                setRenamingId(s.id);
                setRenameDraft(s.title || "");
              }}
              title={s.preview ? String(s.preview) : undefined}
            >
              {renamingId === s.id ? (
                <input
                  value={renameDraft}
                  autoFocus
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => {
                    void renameChat(s.id, renameDraft);
                    setRenamingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void renameChat(s.id, renameDraft);
                      setRenamingId(null);
                    }
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  className="flex-1 min-w-0 bg-[#1e1f20] border border-[#243a5c] rounded-full px-2.5 py-1 text-[13px] outline-none"
                />
              ) : (
                <>
                  <span className="flex-1 text-[13px] truncate">{s.title || `Chat #${s.id}`}</span>
                  {typeof s.messageCount === "number" && s.messageCount > 0 && (
                    <span className="opacity-0 group-hover:opacity-0 text-[10px] text-[#9aa0a6]">{s.messageCount}</span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(s.id);
                      setRenameDraft(s.title || "");
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-[#394457] rounded-full transition-opacity"
                    title="Rename chat (double-click)"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm("Delete this chat and all its messages?")) deleteChat(s.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-[#394457] rounded-full transition-opacity"
                    title="Delete chat"
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </div>
          ))}

          {/* Sections */}
          <div className="text-[12px] font-medium text-[#9aa0a6] px-3 mt-5 mb-1">Manage</div>
          {NAV_SECTIONS.map((n) => (
            <button
              key={n.name}
              onClick={() => selectTab(n.name)}
              className={`w-full flex items-center gap-3 rounded-full px-3 py-2 mb-0.5 text-[13px] transition-colors ${
                tab === n.name ? "bg-[#394457] text-[#e3e9f5]" : "text-[#c4c7c5] hover:bg-[#282a2c] hover:text-[#e8eaed]"
              }`}
            >
              {n.icon}
              <span className="flex-1 text-left">{n.label}</span>
              {/* Live badge — the GPU fine-tune is running right now. */}
              {n.name === "training" && gpuRunning && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-[#1a2b45] text-[#8ab4f8] shrink-0"
                  title={`GPU training — ${gpu?.current?.progress ?? 0}%`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-[#8ab4f8] soft-pulse" />
                  {Math.round(gpu?.current?.progress ?? 0)}%
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Status footer */}
        <div className="p-4 border-t border-[#3c4043]">
          <div className="flex items-center gap-2 text-[12px] text-[#9aa0a6]">
            <span className={`w-2 h-2 rounded-full ${health.status === "Operational" ? "bg-[#81c995]" : "bg-[#fdd663]"}`} />
            {health.status === "Operational" ? "System operational" : "System " + String(health.status).toLowerCase()}
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-14 shrink-0 px-3 md:px-5 border-b border-[#3c4043] flex items-center justify-between bg-[#131314]/90 backdrop-blur">
          <div className="flex items-center gap-2 min-w-0">
            <button className="md:hidden p-2 -ml-1 text-[#c4c7c5] hover:bg-[#1e1f20] hover:text-[#e8eaed] rounded-full" onClick={() => setSidebarOpen(true)}>
              <Menu size={20} />
            </button>
            <h1 className="text-[16px] font-medium text-[#e8eaed] truncate">{tabTitle}</h1>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Live GPU fine-tune — visible from every page. */}
            {gpuRunning && (
              <button
                onClick={() => selectTab("training")}
                title={`GPU training — step ${gpu?.current?.step}/${gpu?.current?.totalSteps} · ETA ${fmtDuration(gpu?.current?.etaSeconds)}`}
                className="hidden sm:inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full bg-[#1a2b45] text-[#8ab4f8] hover:bg-[#243a5c] transition-colors"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-[#8ab4f8] soft-pulse" />
                GPU {Math.round(gpu?.current?.progress ?? 0)}%
                <span className="text-[#9aa0a6]">· {fmtDuration(gpu?.current?.etaSeconds)}</span>
              </button>
            )}
            <button
              onClick={() => setSearchOpen(true)}
              title="Search chats (⌘/Ctrl + K)"
              className="p-2 text-[#c4c7c5] hover:bg-[#1e1f20] hover:text-[#e8eaed] rounded-full transition-colors"
            >
              <Search size={17} />
            </button>
            <button
              onClick={() => setShortcutsOpen(true)}
              title="Keyboard shortcuts (⌘/Ctrl + /)"
              className="hidden sm:inline-flex p-2 text-[#c4c7c5] hover:bg-[#1e1f20] hover:text-[#e8eaed] rounded-full transition-colors"
            >
              <Keyboard size={17} />
            </button>
            {authStatus.passwordRequired && (
              <span className="hidden sm:inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-[#1e1f20] text-[#9aa0a6]">
                <Lock size={11} /> {authStatus.adminAuthed ? "Admin unlocked" : "Admin locked"}
              </span>
            )}
            <span className="hidden sm:inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-[#173f2a] text-[#81c995]">
              <ShieldCheck size={11} /> Admin Mode
            </span>
            <div className="w-8 h-8 rounded-full bg-[#4E7DF5] text-white flex items-center justify-center text-sm font-medium">
              {(userName || "A").slice(0, 1).toUpperCase()}
            </div>
          </div>
        </header>

        <section className={`flex-1 overflow-hidden ${tab === "chat" ? "flex flex-col" : "overflow-y-auto"}`}>
          <div className={tab === "chat" ? "flex-1 flex flex-col min-h-0" : "p-4 md:p-6 max-w-[1100px] mx-auto w-full"}>
            {tab === "chat" && renderChat()}
            {tab === "dashboard" && renderDashboard()}
            {tab === "training" && renderTraining()}
            {tab === "research" && renderResearch()}
            {tab === "datasets" && renderDatasets()}
            {tab === "users" && renderUsers()}
            {tab === "telegram" && renderTelegram()}
            {tab === "settings" && renderSettings()}
            {tab === "logs" && renderLogs()}
          </div>
        </section>
      </main>

      {/* Admin password modal */}
      {passwordModal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setPasswordModal(false)}>
          <div className="bg-[#1e1f20] rounded-3xl border border-[#3c4043] p-6 w-full max-w-sm shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-1">
              <Lock size={18} className="text-[#fdd663]" />
              <div className="text-[15px] font-medium">Admin password</div>
            </div>
            <p className="text-[13px] text-[#9aa0a6] mb-4">Training ও write actions চালু করতে ADMIN_PASSWORD দিন।</p>
            <input
              type="password"
              value={pwValue}
              onChange={(e) => setPwValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && verifyPassword()}
              placeholder="Password"
              autoFocus
              className="w-full bg-[#282a2c] border border-[#3c4043] focus:border-[#8ab4f8] rounded-xl px-3 py-2.5 text-sm outline-none mb-2"
            />
            {pwError && <div className="text-xs text-[#f28b82] mb-2">{pwError}</div>}
            <div className="flex gap-2">
              <button onClick={() => setPasswordModal(false)} className="flex-1 py-2.5 bg-[#1e1f20] hover:bg-[#282a2c] rounded-xl text-[13px] font-medium transition-colors">
                Cancel
              </button>
              <button onClick={verifyPassword} className="flex-1 py-2.5 bg-[#1a73e8] hover:bg-[#2b7de2] text-white rounded-xl text-[13px] font-medium transition-colors">
                Unlock
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chat search palette — ⌘/Ctrl + K */}
      {searchOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 pt-[12vh]" onClick={() => setSearchOpen(false)}>
          <div className="bg-[#1e1f20] rounded-3xl border border-[#3c4043] w-full max-w-lg shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[#3c4043]">
              <Search size={17} className="text-[#9aa0a6] shrink-0" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && searchResults[0]) openChat(searchResults[0].id);
                }}
                placeholder="চ্যাট বা মেসেজ খুঁজুন… (title + message text)"
                autoFocus
                className="flex-1 bg-transparent outline-none text-[15px] placeholder-[#6b7075]"
              />
              <kbd className="text-[10px] text-[#9aa0a6] bg-[#1e1f20] border border-[#3c4043] rounded px-1.5 py-0.5">Esc</kbd>
            </div>
            <div className="max-h-[52vh] overflow-y-auto p-2">
              {searchResults.length === 0 && (
                <div className="px-3 py-6 text-center text-[13px] text-[#9aa0a6]">
                  {searchQuery ? "কিছু পাওয়া যায়নি" : "টাইপ করুন — সব চ্যাট ও মেসেজে খোঁজা হবে"}
                </div>
              )}
              {searchResults.map((s) => (
                <button
                  key={s.id}
                  onClick={() => openChat(s.id)}
                  className="w-full text-left px-3 py-2.5 rounded-2xl hover:bg-[#1e1f20] transition-colors flex items-start gap-3"
                >
                  <MessageSquare size={15} className="mt-0.5 text-[#9aa0a6] shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium truncate">{s.title || `Chat #${s.id}`}</div>
                    {s.preview && <div className="text-[12px] text-[#9aa0a6] truncate">{s.preview}</div>}
                  </div>
                  <span className="text-[11px] text-[#9aa0a6] shrink-0">{s.messageCount ?? 0} msg</span>
                </button>
              ))}
            </div>
            <div className="px-4 py-2 border-t border-[#3c4043] text-[11px] text-[#9aa0a6] flex items-center gap-3">
              <span>↵ প্রথমটি খুলুন</span>
              <span>·</span>
              <button onClick={() => { setSearchOpen(false); setShortcutsOpen(true); }} className="hover:text-[#8ab4f8]">
                সব shortcut দেখুন (⌘/)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Keyboard shortcut cheat sheet — ⌘/Ctrl + / */}
      {shortcutsOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setShortcutsOpen(false)}>
          <div className="bg-[#1e1f20] rounded-3xl border border-[#3c4043] p-6 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-4">
              <Keyboard size={18} className="text-[#8ab4f8]" />
              <div className="text-[15px] font-medium">Chat shortcuts</div>
            </div>
            <div className="space-y-1.5">
              {[
                ["⌘/Ctrl + K", "Chat history খুঁজুন"],
                ["⌘/Ctrl + Shift + O", "নতুন চ্যাট"],
                ["⌘/Ctrl + B", "Sidebar খুলুন / বন্ধ করুন"],
                ["⌘/Ctrl + ↑  বা  ↑", "শেষ প্রশ্নটি edit করুন"],
                ["⌘/Ctrl + Shift + R", "শেষ উত্তরটি regenerate করুন"],
                ["⌘/Ctrl + Shift + ⌫", "এই চ্যাট delete করুন"],
                ["Enter / Shift + Enter", "পাঠান / নতুন লাইন"],
                ["Esc", "Edit, search বা modal বন্ধ"],
                ["Double-click on a chat", "Rename"],
              ].map(([k, d]) => (
                <div key={k} className="flex items-center justify-between gap-3 py-1.5 border-b border-[#3c4043] last:border-0">
                  <span className="text-[13px] text-[#e8eaed]">{d}</span>
                  <kbd className="text-[11px] text-[#e8eaed] bg-[#1e1f20] border border-[#3c4043] rounded-lg px-2 py-1 whitespace-nowrap">{k}</kbd>
                </div>
              ))}
            </div>
            <button
              onClick={() => setShortcutsOpen(false)}
              className="mt-5 w-full py-2.5 bg-[#1e1f20] hover:bg-[#282a2c] rounded-xl text-[13px] font-medium transition-colors"
            >
              বন্ধ করুন
            </button>
          </div>
        </div>
      )}

      {/* Clear-all-history confirmation */}
      {confirmClear && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setConfirmClear(false)}>
          <div className="bg-[#1e1f20] rounded-3xl border border-[#3c4043] p-6 w-full max-w-sm shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-1">
              <Trash2 size={18} className="text-[#f28b82]" />
              <div className="text-[15px] font-medium">Delete all chats?</div>
            </div>
            <p className="text-[13px] text-[#9aa0a6] mb-4">
              সব চ্যাট ও মেসেজ মুছে যাবে। আপনার Knowledge, Memory আর trained model অক্ষত থাকবে।
            </p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmClear(false)} className="flex-1 py-2.5 bg-[#1e1f20] hover:bg-[#282a2c] rounded-xl text-[13px] font-medium transition-colors">
                Cancel
              </button>
              <button
                onClick={() => {
                  setConfirmClear(false);
                  void clearAllChats();
                }}
                className="flex-1 py-2.5 bg-[#d93025] hover:bg-[#e0453a] text-white rounded-xl text-[13px] font-medium transition-colors"
              >
                Delete all
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="toast-in fixed bottom-6 left-1/2 z-50 bg-[#e8eaed] text-[#131314] text-[13px] px-4 py-2.5 rounded-full shadow-lg max-w-[90vw] truncate">
          {toast}
        </div>
      )}
    </div>
  );
}
