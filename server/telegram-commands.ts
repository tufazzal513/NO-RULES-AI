/**
 * Telegram bot commands — the same chat shortcuts, but from your phone.
 * ---------------------------------------------------------------------
 * The web panel has New chat / history / rename / edit / delete / regenerate.
 * Talking to the bot should not be a second-class experience, so the exact
 * same actions exist as slash commands:
 *
 *   /new       — start a fresh conversation (the old one is kept in history)
 *   /history   — the last messages of this conversation
 *   /chats     — every conversation with its message count
 *   /edit …    — rewrite your last question and get a new answer
 *   /again     — regenerate the last answer
 *   /undo      — delete your last question + its answer
 *   /clear     — delete every message of this conversation
 *   /forget    — wipe what the AI remembers about you
 *   /research… — force an online lookup (handled by the brain)
 *   /help      — the list above
 *
 * Everything is answered in the language the user has been writing in
 * (English / বাংলা / Banglish), detected from their recent messages.
 */

import { detectLanguage, t, type Lang } from "./ai/language.ts";

export interface BotCommandDeps {
  db: any;
  ai: { replyAsync(text: string): Promise<{ reply: string; mode: string }> };
  /** Mirror an upsert to the Telegram cloud database (best-effort). */
  mirror: (collection: string, recordId: string | number, payload: any) => void;
  /** Mirror a delete tombstone (best-effort). */
  mirrorDelete: (collection: string, recordId: string | number) => void;
}

/** A command either produced a reply, or asked the caller to treat it as chat. */
export type CommandResult = { handled: true; reply: string } | { handled: false };

const NOT_HANDLED: CommandResult = { handled: false };

export function createBotCommands(deps: BotCommandDeps) {
  const { db, ai, mirror, mirrorDelete } = deps;

  /** The conversation currently attached to this Telegram chat (created on demand). */
  function currentConversation(chatId: number | string, name: string): { id: number } {
    const row = db.prepare("SELECT id FROM conversations WHERE telegram_chat_id = ?").get(String(chatId)) as any;
    if (row) return { id: Number(row.id) };
    const title = `TG: ${name}`;
    const info = db
      .prepare("INSERT INTO conversations (title, telegram_chat_id) VALUES (?, ?)")
      .run(title, String(chatId));
    const id = Number(info.lastInsertRowid);
    mirror("conversations", id, { id, title, telegram_chat_id: String(chatId) });
    return { id };
  }

  /**
   * Which language is this user writing in?
   *
   * A bare "/help" carries no language signal, so recent real messages decide.
   * The current conversation is checked first; if it is empty (right after
   * `/new`) the user's recent Telegram messages in general are used, otherwise
   * every fresh conversation would fall back to English.
   */
  function chatLanguage(sid: number, hint = ""): Lang {
    const fromHint = hint.trim();
    if (fromHint) {
      const l = detectLanguage(fromHint);
      if (l !== "en") return l;
    }
    const pick = (rows: { content: string }[]): Lang | null => {
      for (const r of rows) {
        const l = detectLanguage(r.content || "");
        if (l !== "en") return l;
      }
      return null;
    };
    try {
      const inSession = db
        .prepare(
          "SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user' AND content NOT LIKE '/%' ORDER BY id DESC LIMIT 5"
        )
        .all(sid) as { content: string }[];
      const fromSession = pick(inSession);
      if (fromSession) return fromSession;

      // Nothing in this conversation (e.g. straight after /new) — look wider.
      const anywhere = db
        .prepare(
          "SELECT content FROM chat_messages WHERE source = 'telegram' AND role = 'user' AND content NOT LIKE '/%' ORDER BY id DESC LIMIT 8"
        )
        .all() as { content: string }[];
      const fromAnywhere = pick(anywhere);
      if (fromAnywhere) return fromAnywhere;
    } catch {
      /* fall through to English */
    }
    return fromHint ? detectLanguage(fromHint) : "en";
  }

  /** Persist one message pair helper. */
  function saveMessage(sid: number, role: "user" | "ai", content: string): number {
    const info = db
      .prepare("INSERT INTO chat_messages (session_id, role, content, source) VALUES (?, ?, ?, 'telegram')")
      .run(sid, role, content);
    const id = Number(info.lastInsertRowid);
    mirror("chat_messages", id, { id, session_id: sid, role, content, source: "telegram" });
    return id;
  }

  function deleteMessage(id: number): void {
    db.prepare("DELETE FROM chat_messages WHERE id = ?").run(id);
    mirrorDelete("chat_messages", id);
  }

  // -------------------------------------------------------------------------
  // Command texts
  // -------------------------------------------------------------------------

  function welcome(lang: Lang, name: string): string {
    return t(lang, {
      en:
        `Hi ${name}! 👋 I'm MY-AI — your own personal AI.\n\n` +
        "• Just type a message and I'll reply.\n" +
        "• I understand English, বাংলা and Banglish — write however you like.\n" +
        '• I remember facts about you (try: "My name is …").\n' +
        "• I answer from your own knowledge documents.\n" +
        "• Everything is stored in your Telegram cloud database.\n\n" +
        "Type /help to see every shortcut.",
      bn:
        `আসসালামু আলাইকুম ${name}! 👋 আমি MY-AI — আপনার নিজের AI।\n\n` +
        "• শুধু লিখুন, আমি উত্তর দেব।\n" +
        "• আমি English, বাংলা আর Banglish — তিনটাই বুঝি।\n" +
        '• আপনার তথ্য মনে রাখি (লিখুন: "আমার নাম …")।\n' +
        "• আপনার নিজের ডকুমেন্ট থেকে উত্তর দিই।\n" +
        "• সব কিছু আপনার Telegram ক্লাউডে জমা থাকে।\n\n" +
        "সব shortcut দেখতে /help লিখুন।",
      banglish:
        `Assalamu alaikum ${name}! 👋 Ami MY-AI — apnar nijer AI.\n\n` +
        "• Shudhu likhun, ami uttor debo.\n" +
        "• Ami English, Bangla ar Banglish — tinta i bujhi.\n" +
        '• Apnar totho mone rakhi (likhun: "amar nam …").\n' +
        "• Apnar nijer document theke uttor dii.\n" +
        "• Shob kichu apnar Telegram cloud e joma thake.\n\n" +
        "Shob shortcut dekhte /help likhun.",
    });
  }

  function helpText(lang: Lang): string {
    return t(lang, {
      en:
        "💬 Chat normally — I'll answer.\n" +
        '🧠 Memory: "My name is …", "I like …", "remember that …"\n' +
        "📚 Ask about your knowledge documents\n" +
        "➗ Math: just type 12 * 8 + 4\n\n" +
        "Chat shortcuts:\n" +
        "/new — start a fresh conversation\n" +
        "/history — show the recent messages\n" +
        "/chats — list all conversations\n" +
        "/edit <new text> — rewrite your last question and answer it again\n" +
        "/again — regenerate the last answer\n" +
        "/undo — delete your last question and its answer\n" +
        "/clear — delete every message of this conversation\n" +
        "/forget — wipe what I remember about you\n" +
        "/research <topic> — force an online lookup\n" +
        "/help — this list",
      bn:
        "💬 স্বাভাবিকভাবে লিখুন — আমি উত্তর দেব।\n" +
        '🧠 মেমোরি: "আমার নাম …", "আমার পছন্দ …", "মনে রাখো …"\n' +
        "📚 আপনার ডকুমেন্ট নিয়ে প্রশ্ন করুন\n" +
        "➗ অঙ্ক: শুধু লিখুন 12 * 8 + 4\n\n" +
        "চ্যাট shortcut:\n" +
        "/new — নতুন কথোপকথন শুরু\n" +
        "/history — সাম্প্রতিক মেসেজগুলো দেখুন\n" +
        "/chats — সব কথোপকথনের তালিকা\n" +
        "/edit <নতুন লেখা> — শেষ প্রশ্নটা বদলে আবার উত্তর নিন\n" +
        "/again — শেষ উত্তরটা আবার তৈরি করুন\n" +
        "/undo — শেষ প্রশ্ন ও উত্তর মুছে ফেলুন\n" +
        "/clear — এই কথোপকথনের সব মেসেজ মুছুন\n" +
        "/forget — আপনার সম্পর্কে মনে রাখা সব মুছুন\n" +
        "/research <বিষয়> — জোর করে অনলাইনে খুঁজুন\n" +
        "/help — এই তালিকা",
      banglish:
        "💬 Shabhabik bhabe likhun — ami uttor debo.\n" +
        '🧠 Memory: "amar nam …", "amar pochondo …", "mone rakho …"\n' +
        "📚 Apnar document niye proshno korun\n" +
        "➗ Onko: shudhu likhun 12 * 8 + 4\n\n" +
        "Chat shortcut:\n" +
        "/new — notun kothopokothon shuru\n" +
        "/history — shomprotik message gulo\n" +
        "/chats — shob kothopokothon er talika\n" +
        "/edit <notun lekha> — shesh proshno bodle abar uttor nin\n" +
        "/again — shesh uttor ta abar toiri korun\n" +
        "/undo — shesh proshno o uttor muchun\n" +
        "/clear — ei kothopokothon er shob message muchun\n" +
        "/forget — apnar somporke mone rakha shob muchun\n" +
        "/research <topic> — jor kore online e khujun\n" +
        "/help — ei talika",
    });
  }

  // -------------------------------------------------------------------------
  // Dispatcher
  // -------------------------------------------------------------------------

  /**
   * Handle a slash command. Returns `{ handled: false }` for ordinary text
   * (and for `/research`, which the AI brain itself understands).
   */
  async function handleCommand(rawText: string, chatId: number | string, name: string): Promise<CommandResult> {
    const text = (rawText || "").trim();
    if (!text.startsWith("/")) return NOT_HANDLED;

    // "/edit@MyBot some text" → command "edit", args "some text"
    const match = /^\/([a-z_]+)(?:@\S+)?\s*([\s\S]*)$/i.exec(text);
    if (!match) return NOT_HANDLED;
    const cmd = match[1].toLowerCase();
    const args = (match[2] || "").trim();

    // The brain handles these itself (they need the research service).
    if (cmd === "research" || cmd === "search" || cmd === "khoj" || cmd === "khujo") return NOT_HANDLED;

    const conv = currentConversation(chatId, name);
    const sid = conv.id;
    const lang = chatLanguage(sid, args);

    switch (cmd) {
      case "start":
        return { handled: true, reply: welcome(lang, name) };

      case "help":
      case "commands":
      case "shortcut":
      case "shortcuts":
        return { handled: true, reply: helpText(lang) };

      // --- new conversation ---------------------------------------------------
      case "new":
      case "newchat": {
        const count = Number(
          (db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE session_id = ?").get(sid) as any).c
        );
        if (count === 0) {
          return {
            handled: true,
            reply: t(lang, {
              en: "You're already in a fresh conversation. 🆕",
              bn: "আপনি তো এখনই নতুন কথোপকথনে আছেন। 🆕",
              banglish: "Apni to ekhon i notun kothopokothon e achen. 🆕",
            }),
          };
        }
        // Detach the old conversation (it stays in the history) and open a new one.
        const title =
          (db.prepare("SELECT content FROM chat_messages WHERE session_id = ? AND role='user' ORDER BY id ASC LIMIT 1").get(sid) as any)
            ?.content?.slice(0, 40) || `TG chat #${sid}`;
        db.prepare("UPDATE conversations SET telegram_chat_id = NULL, title = ? WHERE id = ?").run(title, sid);
        mirror("conversations", sid, { id: sid, title, telegram_chat_id: null });
        currentConversation(chatId, name); // opens the fresh one
        return {
          handled: true,
          reply: t(lang, {
            en: `🆕 New conversation started. The previous one ("${title}") is safe in your history — /chats shows them all.`,
            bn: `🆕 নতুন কথোপকথন শুরু হলো। আগেরটা ("${title}") history-তে সংরক্ষিত আছে — /chats দিয়ে সব দেখুন।`,
            banglish: `🆕 Notun kothopokothon shuru holo. Ager ta ("${title}") history te ache — /chats diye shob dekhun.`,
          }),
        };
      }

      // --- history ------------------------------------------------------------
      case "history":
      case "log": {
        const limit = Math.min(Math.max(Number(args) || 10, 1), 30);
        const rows = db
          .prepare("SELECT role, content, created_at FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?")
          .all(sid, limit) as any[];
        if (rows.length === 0) {
          return {
            handled: true,
            reply: t(lang, {
              en: "This conversation is empty. Say something! 💬",
              bn: "এই কথোপকথনে এখনো কিছু নেই। কিছু লিখুন! 💬",
              banglish: "Ei kothopokothon e ekhono kichu nei. Kichu likhun! 💬",
            }),
          };
        }
        const header = t(lang, {
          en: `🕘 Last ${rows.length} message(s):`,
          bn: `🕘 শেষ ${rows.length}টি মেসেজ:`,
          banglish: `🕘 Shesh ${rows.length} ti message:`,
        });
        const body = rows
          .reverse()
          .map((r) => `${r.role === "user" ? "🧑" : "✨"} ${String(r.content).replace(/\s+/g, " ").slice(0, 160)}`)
          .join("\n");
        return { handled: true, reply: `${header}\n\n${body}` };
      }

      // --- all conversations ---------------------------------------------------
      case "chats":
      case "conversations": {
        const rows = db
          .prepare(
            `SELECT c.id, c.title, COUNT(m.id) AS n, MAX(m.created_at) AS last
             FROM conversations c LEFT JOIN chat_messages m ON m.session_id = c.id
             GROUP BY c.id ORDER BY COALESCE(MAX(m.created_at), c.created_at) DESC LIMIT 15`
          )
          .all() as any[];
        if (rows.length === 0) {
          return {
            handled: true,
            reply: t(lang, { en: "No conversations yet.", bn: "এখনো কোনো কথোপকথন নেই।", banglish: "Ekhono kono kothopokothon nei." }),
          };
        }
        const header = t(lang, {
          en: `💬 ${rows.length} conversation(s):`,
          bn: `💬 ${rows.length}টি কথোপকথন:`,
          banglish: `💬 ${rows.length} ti kothopokothon:`,
        });
        const body = rows
          .map((r) => `${r.id === sid ? "▶️" : "•"} ${String(r.title || `Chat #${r.id}`).slice(0, 50)} — ${r.n} msg`)
          .join("\n");
        return { handled: true, reply: `${header}\n\n${body}` };
      }

      // --- edit the last question and answer it again --------------------------
      case "edit":
      case "fix": {
        if (!args) {
          return {
            handled: true,
            reply: t(lang, {
              en: "Send the corrected question like this:\n/edit what is the capital of Bangladesh",
              bn: "এভাবে সংশোধিত প্রশ্নটা পাঠান:\n/edit বাংলাদেশের রাজধানী কী",
              banglish: "Evabe shongshodhito proshno pathan:\n/edit bangladesher rajdhani ki",
            }),
          };
        }
        const lastUser = db
          .prepare("SELECT * FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
          .get(sid) as any;
        if (!lastUser) {
          return {
            handled: true,
            reply: t(lang, {
              en: "There's no question to edit yet.",
              bn: "এখনো কোনো প্রশ্ন নেই যেটা edit করা যায়।",
              banglish: "Ekhono kono proshno nei je ta edit kora jay.",
            }),
          };
        }
        db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?").run(args, lastUser.id);
        mirror("chat_messages", lastUser.id, {
          id: lastUser.id,
          session_id: sid,
          role: "user",
          content: args,
          source: "telegram",
        });
        // Everything after the edited question is stale.
        for (const s of db.prepare("SELECT id FROM chat_messages WHERE session_id = ? AND id > ?").all(sid, lastUser.id) as any[]) {
          deleteMessage(s.id);
        }
        const result = await ai.replyAsync(args);
        saveMessage(sid, "ai", result.reply);
        const note = t(lang, {
          en: `✏️ Edited to: "${args}"`,
          bn: `✏️ বদলে দেওয়া হলো: "${args}"`,
          banglish: `✏️ Bodle deya holo: "${args}"`,
        });
        return { handled: true, reply: `${note}\n\n${result.reply}` };
      }

      // --- regenerate ----------------------------------------------------------
      case "again":
      case "regenerate":
      case "retry": {
        const lastUser = db
          .prepare("SELECT * FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
          .get(sid) as any;
        if (!lastUser) {
          return {
            handled: true,
            reply: t(lang, {
              en: "There's no question to answer again.",
              bn: "আবার উত্তর দেওয়ার মতো কোনো প্রশ্ন নেই।",
              banglish: "Abar uttor deyar moto kono proshno nei.",
            }),
          };
        }
        for (const a of db
          .prepare("SELECT id FROM chat_messages WHERE session_id = ? AND id > ? AND role = 'ai'")
          .all(sid, lastUser.id) as any[]) {
          deleteMessage(a.id);
        }
        const result = await ai.replyAsync(lastUser.content);
        saveMessage(sid, "ai", result.reply);
        return { handled: true, reply: `🔄 ${result.reply}` };
      }

      // --- undo ----------------------------------------------------------------
      case "undo":
      case "delete_last": {
        const lastUser = db
          .prepare("SELECT * FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
          .get(sid) as any;
        if (!lastUser) {
          return {
            handled: true,
            reply: t(lang, { en: "Nothing to undo.", bn: "মোছার মতো কিছু নেই।", banglish: "Muchar moto kichu nei." }),
          };
        }
        let removed = 0;
        for (const r of db.prepare("SELECT id FROM chat_messages WHERE session_id = ? AND id >= ?").all(sid, lastUser.id) as any[]) {
          deleteMessage(r.id);
          removed++;
        }
        return {
          handled: true,
          reply: t(lang, {
            en: `↩️ Removed your last question and its answer (${removed} message(s)).`,
            bn: `↩️ আপনার শেষ প্রশ্ন ও তার উত্তর মুছে ফেলা হয়েছে (${removed}টি মেসেজ)।`,
            banglish: `↩️ Apnar shesh proshno o tar uttor muche fela hoyeche (${removed} ti message).`,
          }),
        };
      }

      // --- clear this conversation ---------------------------------------------
      case "clear":
      case "clearchat": {
        const rows = db.prepare("SELECT id FROM chat_messages WHERE session_id = ?").all(sid) as any[];
        for (const r of rows) deleteMessage(r.id);
        return {
          handled: true,
          reply: t(lang, {
            en: `🧹 Cleared ${rows.length} message(s) from this conversation. Your knowledge and memory are untouched.`,
            bn: `🧹 এই কথোপকথনের ${rows.length}টি মেসেজ মুছে ফেলা হয়েছে। আপনার Knowledge আর Memory অক্ষত আছে।`,
            banglish: `🧹 Ei kothopokothon er ${rows.length} ti message muche fela hoyeche. Apnar Knowledge ar Memory okkhoto ache.`,
          }),
        };
      }

      // --- forget me ------------------------------------------------------------
      case "forget": {
        const rows = db.prepare("SELECT id FROM memory").all() as any[];
        db.prepare("DELETE FROM memory").run();
        for (const r of rows) mirrorDelete("memory", r.id);
        return {
          handled: true,
          reply: t(lang, {
            en: `🧠 Forgotten — ${rows.length} remembered fact(s) removed.`,
            bn: `🧠 ভুলে গেলাম — মনে রাখা ${rows.length}টি তথ্য মুছে ফেলা হয়েছে।`,
            banglish: `🧠 Bhule gelam — mone rakha ${rows.length} ti totho muche fela hoyeche.`,
          }),
        };
      }

      default:
        return {
          handled: true,
          reply: t(lang, {
            en: `I don't know the command "${cmd}". Type /help to see everything I can do.`,
            bn: `"${cmd}" কমান্ডটা আমি চিনি না। /help লিখলে সব দেখতে পাবেন।`,
            banglish: `"${cmd}" command ta ami chini na. /help likhle shob dekhte paben.`,
          }),
        };
    }
  }

  return { handleCommand, currentConversation, chatLanguage, saveMessage };
}
