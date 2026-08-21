/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * MY-AI control panel — Gemini-style chat interface (light theme).
 * -----------------------------------------------------------------
 * The whole app is styled after the Gemini web chat: white canvas,
 * #f0f4f9 sidebar with "New chat" pill + recent chats, centered
 * conversation column, suggestion cards, pill-shaped composer and
 * the sparkle avatar for AI replies.
 */

import { useEffect, useRef, useState } from "react";
import {
  Menu, X, Plus, LayoutDashboard, GraduationCap, Globe, Database, Users,
  Settings, DatabaseBackup, Terminal, Paperclip, Mic, Volume2, Trash2,
  Download, Play, Search, RefreshCw, WifiOff, Copy, BookMarked, ShieldCheck,
  Lock, CheckCircle2, CircleAlert, Clock, ArrowUp, Send,
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

/* ------------------------------------------------------------------------ */
/* ChatView — the Gemini-style conversation surface                         */
/* ------------------------------------------------------------------------ */

interface ChatMessage {
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

function ChatView({ variant, userName, messages, isTyping, input, setInput, onSend, onSave }: ChatViewProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [listening, setListening] = useState(false);
  const [attachMsg, setAttachMsg] = useState("");

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
                <div className="w-8 h-8 shrink-0 mt-0.5 rounded-full bg-[#f0f4f9] flex items-center justify-center">
                  <Sparkle size={18} />
                </div>
              ) : (
                <div className="w-8 h-8 shrink-0 mt-0.5 rounded-full bg-[#4E7DF5] text-white flex items-center justify-center text-sm font-medium">
                  {userName.slice(0, 1).toUpperCase() || "Y"}
                </div>
              )}
              <div className={`min-w-0 ${msg.role === "user" ? "max-w-[85%] md:max-w-[75%]" : "flex-1 max-w-full"}`}>
                {msg.role === "user" ? (
                  <div className="bg-[#eff1f3] text-[#1f1f1f] px-4 py-2.5 rounded-[22px] leading-relaxed whitespace-pre-wrap text-[15px]">
                    {msg.content}
                  </div>
                ) : (
                  <div>
                    <div className="text-sm leading-relaxed whitespace-pre-wrap text-[#1f1f1f]">{msg.content}</div>
                    <div className="mt-1.5 flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                      {msg.mode && modeMeta[msg.mode] && (
                        <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-[#5f6368] bg-[#f0f4f9] border border-[#e3e3e3] px-2 py-0.5 rounded-full">
                          {modeMeta[msg.mode].icon} {modeMeta[msg.mode].label}
                        </span>
                      )}
                      <button
                        onClick={() => navigator.clipboard?.writeText(msg.content)}
                        title="Copy"
                        className="p-1.5 text-[#5f6368] hover:text-[#1f1f1f] hover:bg-[#f0f4f9] rounded-full transition-colors"
                      >
                        <Copy size={15} />
                      </button>
                      <button
                        onClick={() => {
                          const lastUser = [...messages].reverse().find((m) => m.role === "user");
                          if (lastUser) onSend(lastUser.content);
                        }}
                        title="Regenerate"
                        className="p-1.5 text-[#5f6368] hover:text-[#1f1f1f] hover:bg-[#f0f4f9] rounded-full transition-colors"
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
                        className="p-1.5 text-[#5f6368] hover:text-[#1f1f1f] hover:bg-[#f0f4f9] rounded-full transition-colors"
                      >
                        <Volume2 size={15} />
                      </button>
                      <button
                        onClick={() => onSave(msg)}
                        title="Save to knowledge (training data)"
                        className="p-1.5 text-[#5f6368] hover:text-[#1f1f1f] hover:bg-[#f0f4f9] rounded-full transition-colors"
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
              <div className="w-8 h-8 shrink-0 rounded-full bg-[#f0f4f9] flex items-center justify-center">
                <Sparkle size={18} />
              </div>
              <div className="flex-1 pt-1">
                <div className="text-[15px] text-[#1f1f1f]">{variant === "training" ? "প্রশিক্ষণ চলছে" : "Thinking"}…</div>
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
                    className="text-left bg-[#f0f4f9] hover:bg-[#e9eef6] rounded-2xl px-4 py-3.5 text-[14px] text-[#1f1f1f] leading-snug transition-colors"
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
      <div className="shrink-0 bg-gradient-to-t from-white via-white to-transparent px-3 pb-3 pt-6">
        <div className="max-w-[800px] mx-auto">
          {attachMsg && (
            <div className="mb-2 text-xs text-[#1a73e8] bg-[#e8f0fe] border border-[#d2e3fc] rounded-xl px-3 py-2">{attachMsg}</div>
          )}
          <div className="flex items-end gap-1 bg-[#f0f4f9] rounded-[28px] px-2 py-2 shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
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
              className="p-2.5 text-[#444746] hover:bg-[#e9eef6] rounded-full transition-colors shrink-0"
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
              className="flex-1 bg-transparent resize-none outline-none text-[15px] leading-6 text-[#1f1f1f] placeholder-[#80868b] py-2 px-1 max-h-40"
            />
            {micSupported && (
              <button
                onClick={startMic}
                title="Voice input"
                className={`p-2.5 rounded-full transition-colors shrink-0 ${listening ? "text-[#1a73e8] bg-[#d2e3fc]" : "text-[#444746] hover:bg-[#e9eef6]"}`}
              >
                <Mic size={20} />
              </button>
            )}
            <button
              onClick={() => onSend()}
              disabled={!input.trim() && !isTyping}
              className={`ml-1 p-2 rounded-full transition-all shrink-0 ${
                input.trim()
                  ? "bg-[#1a1a1a] text-white hover:bg-[#333]"
                  : "bg-[#c4c7c5] text-white cursor-default"
              }`}
            >
              {input.trim() ? <ArrowUp size={20} /> : <Send size={18} />}
            </button>
          </div>
          <div className="text-center mt-2.5 text-[11px] text-[#5f6368]">
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
    <div className={`bg-white border border-[#e3e3e3] rounded-3xl p-4 md:p-5 ${className}`}>
      {title && (
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 text-[13px] font-medium text-[#1f1f1f]">
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
    <div className="bg-[#f8f9fa] border border-[#e3e3e3] rounded-2xl p-3.5">
      <div className="text-[11px] text-[#5f6368]">{label}</div>
      <div className="mt-1 text-lg font-medium text-[#1f1f1f]">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-[#5f6368]">{sub}</div>}
    </div>
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
      refreshBrain();
    } catch (e: any) {
      setMessages((prev) => [...prev, { role: "ai", content: "⚠️ " + e.message }]);
    } finally {
      setIsTyping(false);
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
      refreshBrain();
    } catch (e: any) {
      setTMessages((prev) => [...prev, { role: "ai", content: "⚠️ " + e.message }]);
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

  const trainModel = async () => {
    setBrainMsg("Training…");
    try {
      const d = await api("/api/v1/ai/train", { method: "POST" });
      setBrainMsg(`Trained on ${d.stats?.trainedMessages ?? 0} messages. Model ready! ✨`);
      refreshBrain();
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

  const authed = !authStatus.passwordRequired || authStatus.adminAuthed;

  /* ---------------------------------------------------------------- */
  /* Page renderers                                                    */
  /* ---------------------------------------------------------------- */

  const renderDashboard = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      <StatChip label="API" value={<span className="text-[#188038]">{health.api}</span>} sub={`Status: ${health.status}`} />
      <StatChip label="Database" value={health.database} sub={health.stats?.totalUsers != null ? `${health.stats.totalUsers} users` : undefined} />
      <StatChip label="Active Model" value={health.model} sub={aiStatus.trained ? `Trained · ${aiStatus.modelChains ?? 0} chains` : "Not trained yet"} />
      <StatChip label="Telegram Storage" value={health.telegram} sub={tgStatus.botUsername ? `@${tgStatus.botUsername}` : "Backups via Telegram"} />

      <Card title="System metrics" icon={<LayoutDashboard size={16} className="text-[#1a73e8]" />} className="md:col-span-2 xl:col-span-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatChip label="Total Users" value={health.stats?.totalUsers ?? "…"} />
          <StatChip label="Conversations" value={health.stats?.totalConversations ?? "…"} />
          <StatChip label="Messages" value={health.stats?.totalMessages ?? "…"} />
          <StatChip label="Knowledge Docs" value={health.stats?.knowledgeDocs ?? "…"} />
        </div>
      </Card>

      <Card title="Quick actions" icon={<ShieldCheck size={16} className="text-[#188038]" />}>
        <div className="space-y-2.5">
          <button onClick={triggerBackup} className="w-full py-2.5 bg-[#e6f4ea] hover:bg-[#ceead6] text-[#188038] rounded-xl text-[13px] font-medium transition-colors">
            💾 Backup DB to Telegram
          </button>
          <button
            onClick={() => tgAction("snapshot", { force: true })}
            className="w-full py-2.5 bg-[#e8f0fe] hover:bg-[#d2e3fc] text-[#1a73e8] rounded-xl text-[13px] font-medium transition-colors"
          >
            📦 Snapshot Now
          </button>
          <button
            onClick={() => api("/api/v1/users/seed", { method: "POST" }).then(() => { fetchHealth(); showToast("Test user created"); }).catch((e) => showToast("⚠️ " + e.message))}
            className="w-full py-2.5 bg-[#fef7e0] hover:bg-[#feefc3] text-[#b06000] rounded-xl text-[13px] font-medium transition-colors"
          >
            🌱 Seed Test User
          </button>
          <button onClick={() => selectTab("training")} className="w-full py-2.5 bg-[#f0f4f9] hover:bg-[#e9eef6] text-[#444746] rounded-xl text-[13px] font-medium transition-colors">
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
          icon={<Globe size={16} className="text-[#1a73e8]" />}
          className="md:col-span-2"
          right={
            <button onClick={() => resetResearch(false)} className="px-3 py-1.5 bg-[#e8f0fe] hover:bg-[#d2e3fc] text-[#1a73e8] rounded-lg text-xs font-medium transition-colors flex items-center gap-1">
              <RefreshCw size={12} /> Reset Cooldowns
            </button>
          }
        >
          <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
            {sources.length === 0 && <div className="text-[13px] text-[#5f6368] p-4 text-center">Loading source status…</div>}
            {sources.map((s: any) => (
              <div key={`${s.name}-${s.host}`} className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl hover:bg-[#f8f9fa]">
                <div className="min-w-0">
                  <div className="text-[13px] text-[#1f1f1f] truncate">{s.name}</div>
                  <div className="text-[11px] text-[#5f6368] font-mono truncate">{s.host}</div>
                </div>
                {s.ready ? (
                  <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-[#188038] bg-[#e6f4ea] border border-[#ceead6] px-2 py-0.5 rounded-full">● Ready</span>
                ) : (
                  <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-[#b06000] bg-[#fef7e0] border border-[#feefc3] px-2 py-0.5 rounded-full" title={`${s.failures} failure(s)`}>
                    <WifiOff size={11} /> {fmtCooldown(s.cooldownRemainingMs)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="Try a topic"
          icon={<Search size={16} className="text-[#1a73e8]" />}
          className="md:col-span-2"
          right={
            <button onClick={() => resetResearch(true)} className="px-3 py-1.5 bg-[#f0f4f9] hover:bg-[#e9eef6] text-[#444746] rounded-lg text-xs font-medium transition-colors">
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
              className="flex-1 min-w-0 bg-[#f0f4f9] border border-transparent focus:border-[#d2e3fc] rounded-xl px-3 py-2.5 text-sm outline-none placeholder:text-[#80868b]"
            />
            <button onClick={runResearch} disabled={researchBusy} className="px-4 py-2.5 bg-[#1a73e8] hover:bg-[#1765cc] disabled:opacity-50 text-white rounded-xl text-sm font-medium transition-colors flex items-center gap-1.5 shrink-0">
              {researchBusy ? "…" : (<><Search size={14} /> Search</>)}
            </button>
          </div>
          <div className="text-xs text-[#5f6368] mb-3">
            In chat, question-like messages are researched automatically — or type /research &lt;topic&gt;. Bengali questions (কে, কী, কেন, সর্বশেষ, খবর…) work too.
          </div>
          {researchMsg && <div className="text-xs text-[#1a73e8] p-2.5 bg-[#e8f0fe] border border-[#d2e3fc] rounded-lg mb-3">{researchMsg}</div>}
          {researchResult && (
            <div className="p-3.5 bg-[#f8f9fa] rounded-xl border border-[#e3e3e3] text-[13px] leading-relaxed text-[#1f1f1f] overflow-y-auto max-h-[280px] whitespace-pre-wrap">
              {researchResult.ok ? researchResult.data?.finding?.answer : researchResult.message}
            </div>
          )}
          {!researchResult && (
            <div className="flex flex-col justify-center items-center text-center text-[#80868b] py-8">
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
          <Card title="🔒 Admin only" icon={<Lock size={16} className="text-[#b06000]" />}>
            <p className="text-[13px] text-[#5f6368] leading-relaxed mb-4">
              এই ট্যাবে কেবল admin প্রশিক্ষণ দিতে পারেন (ADMIN_PASSWORD চালু আছে)। পাসওয়ার্ড দিয়ে unlock করুন।
            </p>
            <button
              onClick={() => setPasswordModal(true)}
              className="w-full py-2.5 bg-[#1a73e8] hover:bg-[#1765cc] text-white rounded-xl text-sm font-medium transition-colors"
            >
              Unlock with password
            </button>
          </Card>
        </div>
      );
    }
    return (
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        {/* Training chat — chat with the AI right here, admin only */}
        <div className="xl:col-span-3 flex flex-col bg-white border border-[#e3e3e3] rounded-3xl overflow-hidden" style={{ minHeight: 560 }}>
          <div className="px-4 md:px-5 py-3 border-b border-[#e3e3e3] flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <GraduationCap size={16} className="text-[#1a73e8]" />
              <span className="text-[13px] font-medium">প্রশিক্ষণ চ্যাট — messages are stored as training data</span>
            </div>
            {tActiveId && (
              <button
                onClick={() => {
                  sessionStorage.removeItem(TRAINING_SESSION_KEY);
                  setTActiveId(null);
                  setTMessages([{ role: "ai", content: "প্রশিক্ষণ চ্যাট — এখানে যা-ই লিখবেন, সব training data হিসেবে save হবে। ✍️" }]);
                }}
                className="text-[11px] text-[#5f6368] hover:text-[#1f1f1f] flex items-center gap-1"
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
          />
        </div>

        <div className="xl:col-span-2 space-y-4">
          <Card title="Local AI model" icon={<GraduationCap size={16} className="text-[#1a73e8]" />}>
            <div className="text-xl font-medium text-[#1f1f1f]">{aiStatus.trained ? "Trained ✓" : "Not trained yet"}</div>
            <div className="mt-1.5 text-xs text-[#5f6368]">
              Messages: {aiStatus.corpusMessages ?? "…"} · Knowledge: {aiStatus.knowledgeDocs ?? "…"} · Memory: {aiStatus.memoryFacts ?? "…"}
              {aiStatus.trained && <> · Chains: {aiStatus.modelChains} · Vocab: {aiStatus.vocabSize}</>}
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={trainModel} className="flex-1 py-2.5 bg-[#1a73e8] hover:bg-[#1765cc] text-white rounded-xl text-[13px] font-medium transition-colors flex items-center justify-center gap-1.5">
                <Play size={14} /> Train on My Messages
              </button>
              <a href="/api/v1/dataset/export" className="flex-1 py-2.5 bg-[#e8f0fe] hover:bg-[#d2e3fc] text-[#1a73e8] rounded-xl text-[13px] font-medium transition-colors flex items-center justify-center gap-1.5">
                <Download size={14} /> Export Dataset
              </a>
            </div>
            {brainMsg && <div className="mt-3 text-xs text-[#1f1f1f] p-2.5 bg-[#f8f9fa] rounded-lg">{brainMsg}</div>}
          </Card>

          <Card title="Knowledge 📚" icon={<BookMarked size={16} className="text-[#188038]" />}>
            <div className="space-y-2 mb-3">
              <input
                value={knowTitle}
                onChange={(e) => setKnowTitle(e.target.value)}
                placeholder="Title"
                className="w-full bg-[#f0f4f9] border border-transparent focus:border-[#d2e3fc] rounded-lg px-3 py-2 text-[13px] outline-none placeholder:text-[#80868b]"
              />
              <textarea
                value={knowContent}
                onChange={(e) => setKnowContent(e.target.value)}
                placeholder="Paste your notes, documents, or anything the AI should know…"
                rows={2}
                className="w-full bg-[#f0f4f9] border border-transparent focus:border-[#d2e3fc] rounded-lg px-3 py-2 text-[13px] outline-none placeholder:text-[#80868b] resize-none"
              />
              <button onClick={addKnowledge} className="w-full py-2 bg-[#e6f4ea] hover:bg-[#ceead6] text-[#188038] rounded-lg text-[13px] font-medium transition-colors">
                Add Knowledge
              </button>
            </div>
            <div className="space-y-1.5 max-h-44 overflow-y-auto">
              {knowledge.length === 0 && <div className="text-xs text-[#5f6368] text-center p-3">No knowledge yet.</div>}
              {knowledge.map((k: any) => (
                <div key={k.id} className="flex justify-between items-start gap-2 px-2.5 py-2 rounded-lg hover:bg-[#f8f9fa]">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[#1f1f1f] truncate">{k.title}</div>
                    <div className="text-[11px] text-[#5f6368] truncate">{k.content.slice(0, 70)}</div>
                  </div>
                  <button onClick={() => deleteKnowledge(k.id)} className="p-1 text-[#5f6368] hover:text-[#c5221f] shrink-0">
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
                className="flex-1 min-w-0 bg-[#f0f4f9] border border-transparent focus:border-[#d2e3fc] rounded-lg px-3 py-2 text-[13px] outline-none placeholder:text-[#80868b]"
              />
              <input
                value={memValue}
                onChange={(e) => setMemValue(e.target.value)}
                placeholder="Value"
                className="flex-1 min-w-0 bg-[#f0f4f9] border border-transparent focus:border-[#d2e3fc] rounded-lg px-3 py-2 text-[13px] outline-none placeholder:text-[#80868b]"
              />
              <button onClick={addMemory} className="px-3 py-2 bg-[#e8f0fe] hover:bg-[#d2e3fc] text-[#1a73e8] rounded-lg text-[13px] font-medium shrink-0">
                Save
              </button>
            </div>
            <div className="space-y-1.5 max-h-44 overflow-y-auto">
              {memory.length === 0 && <div className="text-xs text-[#5f6368] text-center p-3">No memories yet — try "My name is …" in chat.</div>}
              {memory.map((m: any) => (
                <div key={m.id} className="flex justify-between items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-[#f8f9fa]">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[#1f1f1f] truncate">{m.key}</div>
                    <div className="text-[11px] text-[#5f6368] truncate">{m.value}</div>
                  </div>
                  <button onClick={() => deleteMemory(m.id)} className="p-1 text-[#5f6368] hover:text-[#c5221f] shrink-0">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    );
  };

  const renderDatasets = () => (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <StatChip label="Conversations" value={dataset?.conversations ?? "…"} />
      <StatChip label="Messages" value={dataset?.totalMessages ?? "…"} sub={`${dataset?.userMessages ?? 0} user · ${dataset?.aiMessages ?? 0} AI`} />
      <StatChip label="Training pairs" value={dataset?.pairs ?? "…"} sub="user → ai (JSONL ready)" />

      <Card title="Where training data comes from (2 places)" icon={<Database size={16} className="text-[#1a73e8]" />} className="md:col-span-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-[#f8f9fa] border border-[#e3e3e3] rounded-2xl p-3.5">
            <div className="text-[11px] text-[#5f6368] mb-1">১. Chat messages</div>
            <div className="flex flex-wrap gap-1.5">
              {(Object.entries(dataset?.bySource ?? {}) as [string, number][]).map(([s, n]) => (
                <span key={s} className="text-[11px] bg-white border border-[#e3e3e3] px-2 py-0.5 rounded-full">
                  {s}: {n}
                </span>
              ))}
            </div>
          </div>
          <div className="bg-[#f8f9fa] border border-[#e3e3e3] rounded-2xl p-3.5">
            <div className="text-[11px] text-[#5f6368] mb-1">২. Research findings → knowledge</div>
            <div className="text-sm text-[#1f1f1f]">
              {dataset?.researchFindings ?? "…"} <span className="text-[11px] text-[#5f6368]">of {dataset?.knowledgeDocs ?? "…"} docs</span>
            </div>
          </div>
          <div className="bg-[#f8f9fa] border border-[#e3e3e3] rounded-2xl p-3.5">
            <div className="text-[11px] text-[#5f6368] mb-1">Trained model</div>
            <div className="text-sm text-[#1f1f1f]">{dataset?.modelChains ?? 0} chains · {dataset?.vocabSize ?? 0} vocab</div>
          </div>
        </div>
      </Card>

      <Card
        title="Conversations"
        icon={<Database size={16} className="text-[#1a73e8]" />}
        className="md:col-span-3"
        right={
          <a href="/api/v1/dataset/export" className="px-3 py-1.5 bg-[#e8f0fe] hover:bg-[#d2e3fc] text-[#1a73e8] rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5">
            <Download size={13} /> Export JSONL
          </a>
        }
      >
        <div className="space-y-1 max-h-96 overflow-y-auto">
          {sessions.length === 0 && <div className="text-[13px] text-[#5f6368] p-4 text-center">No conversations yet.</div>}
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl hover:bg-[#f8f9fa]">
              <div className="min-w-0">
                <div className="text-[13px] text-[#1f1f1f] truncate">{s.title || `Chat #${s.id}`}</div>
                <div className="text-[11px] text-[#5f6368]">#{s.id} · {s.created_at}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => { setActiveId(s.id); selectTab("chat"); }} className="px-2.5 py-1 text-[11px] bg-[#f0f4f9] hover:bg-[#e9eef6] rounded-lg transition-colors">
                  Open
                </button>
                <button onClick={() => deleteChat(s.id)} className="p-1.5 text-[#5f6368] hover:text-[#c5221f] transition-colors">
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
      <Card title="Add user" icon={<Users size={16} className="text-[#1a73e8]" />}>
        <div className="space-y-2">
          <input
            value={userNameIn}
            onChange={(e) => setUserNameIn(e.target.value)}
            placeholder="Name"
            className="w-full bg-[#f0f4f9] border border-transparent focus:border-[#d2e3fc] rounded-lg px-3 py-2 text-[13px] outline-none placeholder:text-[#80868b]"
          />
          <input
            value={userEmail}
            onChange={(e) => setUserEmail(e.target.value)}
            placeholder="Email"
            className="w-full bg-[#f0f4f9] border border-transparent focus:border-[#d2e3fc] rounded-lg px-3 py-2 text-[13px] outline-none placeholder:text-[#80868b]"
          />
          <button onClick={addUser} className="w-full py-2 bg-[#1a73e8] hover:bg-[#1765cc] text-white rounded-lg text-[13px] font-medium transition-colors">
            Add User
          </button>
        </div>
      </Card>
      <Card title={`All users (${users.length})`} icon={<Users size={16} className="text-[#188038]" />} className="md:col-span-2">
        <div className="space-y-1.5 max-h-96 overflow-y-auto">
          {users.length === 0 && <div className="text-[13px] text-[#5f6368] p-4 text-center">No users yet — add one or seed a test user from the Dashboard.</div>}
          {users.map((u) => (
            <div key={u.id} className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl hover:bg-[#f8f9fa]">
              <div className="min-w-0">
                <div className="text-[13px] text-[#1f1f1f] truncate">{u.name}</div>
                <div className="text-[11px] text-[#5f6368] truncate">{u.email} · joined {u.created_at}</div>
              </div>
              <button onClick={() => deleteUser(u.id)} className="p-1.5 text-[#5f6368] hover:text-[#c5221f] transition-colors shrink-0">
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
      ready: { label: "Ready", cls: "bg-[#e6f4ea] text-[#188038] border-[#ceead6]" },
      restoring: { label: "Restoring…", cls: "bg-[#fef7e0] text-[#b06000] border-[#feefc3]" },
      starting: { label: "Starting…", cls: "bg-[#e8f0fe] text-[#1a73e8] border-[#d2e3fc]" },
      restore_failed: { label: "Restore Failed", cls: "bg-[#fce8e6] text-[#c5221f] border-[#f5c6c2]" },
    };
    const si = stateInfo[state] || stateInfo.starting;
    const busy = !!tgActionStatus || tgStatus.snapshotInProgress || tgStatus.restoreInProgress;
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Telegram Cloud Database" icon={<DatabaseBackup size={16} className="text-[#b06000]" />} className="md:col-span-2">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-[13px] font-medium ${si.cls}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${state === "ready" ? "bg-[#188038]" : "bg-current soft-pulse"}`} />
                {si.label}
              </span>
              <div className="mt-2.5 text-xs text-[#5f6368] space-y-0.5">
                <div>Connection: {tgStatus.configured ? "✅ configured" : "❌ not configured"}</div>
                <div>Bot Token: {tgStatus.botTokenSet ? "✅ set" : "❌ missing"} · Channel ID: {tgStatus.chatIdSet ? "✅ set" : "❌ missing"}</div>
                {tgStatus.botUsername && <div>Bot: @{tgStatus.botUsername}</div>}
                {tgStatus.channelTitle && <div>Channel: {tgStatus.channelTitle}</div>}
              </div>
            </div>
            <button onClick={() => tgAction("verify")} className="shrink-0 px-4 py-2.5 bg-[#e6f4ea] hover:bg-[#ceead6] text-[#188038] rounded-xl text-[13px] font-medium transition-colors">
              Verify Connection
            </button>
          </div>
          {state === "restore_failed" && (
            <div className="mt-3 p-3 bg-[#fce8e6] border border-[#f5c6c2] rounded-xl text-xs text-[#c5221f] break-words">
              ⚠️ Restore failed — local data was NOT modified and the Telegram bot is paused.
              {tgStatus.lastError && <div className="mt-1 font-mono text-[10px] opacity-80">{tgStatus.lastError}</div>}
            </div>
          )}
        </Card>

        <div className="grid grid-cols-2 gap-3 md:col-span-2">
          <StatChip label="Last Backup" value={fmtTime(tgStatus.lastSnapshotAt)} />
          <StatChip label="Last Restore" value={fmtTime(tgStatus.lastRestoreAt)} />
          <StatChip label="Auto Backup" value={tgStatus.autoSnapshotEnabled ? `On · every ${tgStatus.snapshotIntervalMinutes ?? 30} min` : "Off"} sub={`Next: ${fmtTime(tgStatus.nextSnapshotAt)}`} />
          <StatChip label="Auto Restore" value={tgStatus.autoRestoreEnabled ? "On at startup" : "Off"} sub={tgStatus.restoreOnEmptyOnly ? "Only when the local DB is empty" : "Always on startup"} />
        </div>

        <Card title="Cloud actions" icon={<DatabaseBackup size={16} className="text-[#1a73e8]" />}>
          <div className="space-y-2.5">
            <button onClick={() => tgAction("snapshot", { force: true })} disabled={busy} className="w-full py-2.5 bg-[#e8f0fe] hover:bg-[#d2e3fc] text-[#1a73e8] rounded-xl text-[13px] font-medium transition-all disabled:opacity-50">
              📦 Backup Now
            </button>
            <button
              onClick={() => {
                if (confirm("Restore the latest Telegram snapshot? This replaces the current local database.")) tgAction("restore", { force: true });
              }}
              disabled={busy}
              className="w-full py-2.5 bg-[#fef7e0] hover:bg-[#feefc3] text-[#b06000] rounded-xl text-[13px] font-medium transition-all disabled:opacity-50"
            >
              ♻️ Restore Latest
            </button>
            <button onClick={() => tgAction("sync")} disabled={busy} className="w-full py-2.5 bg-[#f0f4f9] hover:bg-[#e9eef6] text-[#444746] rounded-xl text-[13px] font-medium transition-all disabled:opacity-50">
              🔄 Mirror All Records to Telegram
            </button>
            <a href="/api/v1/telegram/snapshot/download" className="block w-full py-2.5 text-center bg-[#f0f4f9] hover:bg-[#e9eef6] text-[#444746] rounded-xl text-[13px] font-medium transition-all">
              ⬇️ Download Snapshot (JSON)
            </a>
          </div>
          {tgActionStatus && <div className="mt-3 text-center text-xs text-[#5f6368] p-2 bg-[#f8f9fa] rounded-lg">{tgActionStatus}</div>}
          {tgResult && (
            <div className={`mt-3 text-xs p-3 rounded-lg break-words ${tgResult.ok ? "bg-[#e6f4ea] text-[#188038] border border-[#ceead6]" : "bg-[#fce8e6] text-[#c5221f] border border-[#f5c6c2]"}`}>
              {tgResult.message}
              {tgResult.data?.checksum && <div className="mt-2 font-mono text-[10px] text-[#5f6368] break-all">checksum: {tgResult.data.checksum}</div>}
            </div>
          )}
        </Card>

        <Card title={`Snapshots (${tgSnapshots.length})`} icon={<Clock size={16} className="text-[#188038]" />}>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {tgSnapshots.length === 0 && <div className="text-xs text-[#5f6368] text-center p-4">No snapshots yet. Press "Backup Now".</div>}
            {tgSnapshots.map((s: any) => (
              <div key={s.id} className="px-2.5 py-2 rounded-lg hover:bg-[#f8f9fa]">
                <div className="text-[10px] text-[#5f6368] font-mono break-all">{s.telegram_file_id}</div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-[10px] text-[#5f6368]">msg {s.telegram_message_id} · {s.created_at}</span>
                  <button
                    onClick={() => tgAction("restore", { fileId: s.telegram_file_id, force: true })}
                    disabled={busy}
                    className="shrink-0 px-2 py-1 text-[10px] bg-[#fef7e0] hover:bg-[#feefc3] text-[#b06000] border border-[#feefc3] rounded-md disabled:opacity-50"
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
        <Card title="🔎 Online research" icon={<Globe size={16} className="text-[#1a73e8]" />} className="md:col-span-2">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            <StatChip label="Enabled" value={r.enabled ? "On" : "Off"} />
            <StatChip label="Cache TTL" value={`${r.cacheTtlMinutes} min`} />
            <StatChip label="Time budget" value={`${r.timeoutMs} ms`} />
            <StatChip label="Save findings → knowledge" value={r.saveToKnowledge ? "On" : "Off"} />
            <StatChip label="Max attempts / call" value={r.maxAttempts ?? 8} />
            <StatChip label="Requests / minute cap" value={r.maxRequestsPerMinute ?? 60} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => resetResearch(false)} className="px-3 py-2 bg-[#e8f0fe] hover:bg-[#d2e3fc] text-[#1a73e8] rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5">
              <RefreshCw size={13} /> Reset Cooldowns
            </button>
            <button onClick={() => resetResearch(true)} className="px-3 py-2 bg-[#f0f4f9] hover:bg-[#e9eef6] text-[#444746] rounded-lg text-xs font-medium transition-colors">
              Clear Research Cache
            </button>
          </div>
        </Card>

        <Card title="☁️ Telegram cloud" icon={<DatabaseBackup size={16} className="text-[#188038]" />}>
          <div className="space-y-2 text-[13px] text-[#1f1f1f]">
            <div className="flex justify-between"><span className="text-[#5f6368]">Configured</span><span>{tg.configured ? "✅" : "❌"}</span></div>
            <div className="flex justify-between"><span className="text-[#5f6368]">Bot token set</span><span>{tg.botTokenSet ? "✅" : "❌"}</span></div>
            <div className="flex justify-between"><span className="text-[#5f6368]">Storage channel set</span><span>{tg.storageChatIdSet ? "✅" : "❌"}</span></div>
            <div className="flex justify-between"><span className="text-[#5f6368]">Bot running</span><span>{tg.botRunning ? "✅" : "❌"}</span></div>
            <div className="flex justify-between"><span className="text-[#5f6368]">Auto restore</span><span>{tg.autoRestore ? "On" : "Off"}</span></div>
            <div className="flex justify-between"><span className="text-[#5f6368]">Auto snapshot</span><span>{tg.autoSnapshot ? `On · ${tg.snapshotIntervalMinutes} min` : "Off"}</span></div>
          </div>
        </Card>

        <Card title="🔐 Admin" icon={<Lock size={16} className="text-[#b06000]" />}>
          <div className="text-[13px] text-[#1f1f1f] leading-relaxed">
            {settings?.adminPasswordRequired ? (
              <>
                <div className="flex items-center gap-2 text-[#188038] font-medium"><CheckCircle2 size={15} /> Admin password is ON</div>
                <div className="mt-1.5 text-xs text-[#5f6368]">
                  Training, Users, Datasets deletion and other write actions require the password. Token: {authStatus.adminAuthed ? "unlocked 🔓" : "locked 🔒"}.
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 font-medium"><CircleAlert size={15} className="text-[#b06000]" /> Admin password is OFF</div>
                <div className="mt-1.5 text-xs text-[#5f6368]">
                  Single-user panel — every action is open. Set <code className="bg-[#f0f4f9] px-1 rounded">ADMIN_PASSWORD</code> to lock training &amp; write actions.
                </div>
              </>
            )}
          </div>
        </Card>

        <Card title="🖥️ Runtime" icon={<Settings size={16} className="text-[#5f6368]" />} className="md:col-span-2">
          <div className="space-y-1.5 text-xs text-[#5f6368]">
            <div>Database: <span className="font-mono text-[#1f1f1f] break-all">{settings?.database ?? "…"}</span></div>
            <div>Port: <span className="text-[#1f1f1f]">{settings?.port ?? "…"}</span> · Cloud state: <span className="text-[#1f1f1f]">{settings?.cloudState ?? "…"}</span></div>
            <div>All values come from environment variables — change them in Render's dashboard (env vars) or <span className="font-mono">.env</span>, then redeploy.</div>
          </div>
        </Card>
      </div>
    );
  };

  const renderLogs = () => {
    const levelCls: Record<string, string> = {
      error: "text-[#c5221f]",
      warn: "text-[#b06000]",
      info: "text-[#188038]",
      debug: "text-[#5f6368]",
    };
    return (
      <Card
        title="Recent activity"
        icon={<Terminal size={16} className="text-[#1a73e8]" />}
        right={
          <button onClick={() => loadPageData("logs")} className="px-3 py-1.5 bg-[#f0f4f9] hover:bg-[#e9eef6] text-[#444746] rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5">
            <RefreshCw size={13} /> Refresh
          </button>
        }
      >
        <div className="space-y-1 max-h-[70vh] overflow-y-auto font-mono text-[11px]">
          {logs.length === 0 && <div className="text-[#5f6368] p-4 text-center">No activity yet.</div>}
          {logs.map((l) => (
            <div key={l.id} className="flex gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[#f8f9fa] break-all">
              <span className="shrink-0 text-[#5f6368]">{new Date(l.at).toLocaleTimeString()}</span>
              <span className={`shrink-0 uppercase w-11 ${levelCls[l.level] ?? ""}`}>{l.level}</span>
              <span className="shrink-0 text-[#1a73e8]">{l.source}</span>
              <span className="text-[#1f1f1f]">{l.message}</span>
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
          <div className="mt-1 text-[#5f6368] text-lg">How can I help you today?</div>
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
      />
    </div>
  );

  /* ---------------------------------------------------------------- */
  /* Shell                                                             */
  /* ---------------------------------------------------------------- */

  const tabTitle =
    tab === "chat" ? "MY-AI" : NAV_SECTIONS.find((n) => n.name === tab)?.label ?? "MY-AI";

  return (
    <div className="flex h-screen w-full bg-white text-[#1f1f1f] overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && <div className="fixed inset-0 bg-black/40 z-30 md:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* Sidebar — Gemini style */}
      <aside
        className={`drawer fixed inset-y-0 left-0 z-40 w-[280px] bg-[#f0f4f9] flex flex-col md:static md:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="p-4 pb-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 px-1">
              <Sparkle size={22} />
              <span className="text-[18px] font-medium tracking-tight text-[#1f1f1f]">MY<span className="text-[#4E7DF5]">-AI</span></span>
            </div>
            <button className="md:hidden p-1.5 text-[#444746] hover:bg-[#e9eef6] rounded-full" onClick={() => setSidebarOpen(false)}>
              <X size={18} />
            </button>
          </div>

          {/* New chat pill */}
          <button
            onClick={() => {
              newChat();
              selectTab("chat");
            }}
            className="mt-4 w-full flex items-center gap-2.5 bg-[#d3e3fd] hover:bg-[#c2d8fb] text-[#041e49] rounded-full px-4 py-2.5 text-[14px] font-medium transition-colors"
          >
            <Plus size={18} strokeWidth={2.5} />
            New chat
          </button>
        </div>

        {/* Recent chats */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="text-[12px] font-medium text-[#5f6368] px-3 mb-1">Recent</div>
          {sessions.length === 0 && <div className="text-[12px] text-[#5f6368] px-3 py-2">No chats yet</div>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`group flex items-center gap-2 rounded-full px-3 py-2 mb-0.5 cursor-pointer transition-colors ${
                tab === "chat" && activeId === s.id ? "bg-[#d3e3fd] text-[#041e49]" : "text-[#444746] hover:bg-[#e9eef6]"
              }`}
              onClick={() => {
                setActiveId(s.id);
                selectTab("chat");
              }}
            >
              <span className="flex-1 text-[13px] truncate">{s.title || `Chat #${s.id}`}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm("Delete this chat and all its messages?")) deleteChat(s.id);
                }}
                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-[#d3e3fd] rounded-full transition-opacity"
                title="Delete chat"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}

          {/* Sections */}
          <div className="text-[12px] font-medium text-[#5f6368] px-3 mt-5 mb-1">Manage</div>
          {NAV_SECTIONS.map((n) => (
            <button
              key={n.name}
              onClick={() => selectTab(n.name)}
              className={`w-full flex items-center gap-3 rounded-full px-3 py-2 mb-0.5 text-[13px] transition-colors ${
                tab === n.name ? "bg-[#d3e3fd] text-[#041e49]" : "text-[#444746] hover:bg-[#e9eef6]"
              }`}
            >
              {n.icon}
              {n.label}
            </button>
          ))}
        </div>

        {/* Status footer */}
        <div className="p-4 border-t border-[#e3e3e3]">
          <div className="flex items-center gap-2 text-[12px] text-[#5f6368]">
            <span className={`w-2 h-2 rounded-full ${health.status === "Operational" ? "bg-[#188038]" : "bg-[#b06000]"}`} />
            {health.status === "Operational" ? "System operational" : "System " + String(health.status).toLowerCase()}
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-14 shrink-0 px-3 md:px-5 border-b border-[#e3e3e3] flex items-center justify-between bg-white/90 backdrop-blur">
          <div className="flex items-center gap-2 min-w-0">
            <button className="md:hidden p-2 -ml-1 text-[#444746] hover:bg-[#f0f4f9] rounded-full" onClick={() => setSidebarOpen(true)}>
              <Menu size={20} />
            </button>
            <h1 className="text-[16px] font-medium text-[#1f1f1f] truncate">{tabTitle}</h1>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {authStatus.passwordRequired && (
              <span className="hidden sm:inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-[#f0f4f9] text-[#5f6368]">
                <Lock size={11} /> {authStatus.adminAuthed ? "Admin unlocked" : "Admin locked"}
              </span>
            )}
            <span className="hidden sm:inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-[#e6f4ea] text-[#188038]">
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
          <div className="bg-white rounded-3xl border border-[#e3e3e3] p-6 w-full max-w-sm shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-1">
              <Lock size={18} className="text-[#b06000]" />
              <div className="text-[15px] font-medium">Admin password</div>
            </div>
            <p className="text-[13px] text-[#5f6368] mb-4">Training ও write actions চালু করতে ADMIN_PASSWORD দিন।</p>
            <input
              type="password"
              value={pwValue}
              onChange={(e) => setPwValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && verifyPassword()}
              placeholder="Password"
              autoFocus
              className="w-full bg-[#f0f4f9] border border-transparent focus:border-[#d2e3fc] rounded-xl px-3 py-2.5 text-sm outline-none mb-2"
            />
            {pwError && <div className="text-xs text-[#c5221f] mb-2">{pwError}</div>}
            <div className="flex gap-2">
              <button onClick={() => setPasswordModal(false)} className="flex-1 py-2.5 bg-[#f0f4f9] hover:bg-[#e9eef6] rounded-xl text-[13px] font-medium transition-colors">
                Cancel
              </button>
              <button onClick={verifyPassword} className="flex-1 py-2.5 bg-[#1a73e8] hover:bg-[#1765cc] text-white rounded-xl text-[13px] font-medium transition-colors">
                Unlock
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="toast-in fixed bottom-6 left-1/2 z-50 bg-[#1f1f1f] text-white text-[13px] px-4 py-2.5 rounded-full shadow-lg max-w-[90vw] truncate">
          {toast}
        </div>
      )}
    </div>
  );
}
