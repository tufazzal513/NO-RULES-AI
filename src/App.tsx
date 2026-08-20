/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import { Menu, X, Activity, Database, BrainCircuit, MessageSquare, DatabaseBackup, Users, Settings, Send, Sparkles, Paperclip, Mic, Volume2, Trash2, Download, Play } from 'lucide-react';

export default function App() {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('Dashboard');
  const [healthStatus, setHealthStatus] = useState({
    status: 'Checking...',
    api: 'Checking...',
    database: 'Checking...',
    model: 'Checking...',
    telegram: 'Checking...'
  });
  const [stats, setStats] = useState({
    totalUsers: 'Loading...',
    totalConversations: 'Loading...',
    knowledgeDocs: 'Loading...',
    datasetCount: 'Loading...'
  });
  const [backupStatus, setBackupStatus] = useState('');

  // Telegram Storage states
  const [tgStatus, setTgStatus] = useState<any>({
    configured: false,
    botTokenSet: false,
    chatIdSet: false,
    indexedRecords: 0
  });
  const [tgActionStatus, setTgActionStatus] = useState('');
  const [tgResult, setTgResult] = useState<any>(null);
  const [tgSnapshots, setTgSnapshots] = useState<any[]>([]);

  const fetchTelegramStatus = async () => {
    try {
      const res = await fetch('/api/v1/telegram/status');
      const data = await res.json();
      setTgStatus(data);
    } catch (e) {
      console.error('Failed to fetch Telegram status:', e);
    }
  };

  const fetchTelegramSnapshots = async () => {
    try {
      const res = await fetch('/api/v1/telegram/snapshots');
      const data = await res.json();
      setTgSnapshots(data.snapshots || []);
    } catch (e) {
      console.error('Failed to fetch Telegram snapshots:', e);
    }
  };

  useEffect(() => {
    fetchTelegramStatus();
    fetchTelegramSnapshots();
  }, []);

  // While the app is restoring from Telegram, poll so the badge flips to Ready
  // as soon as the restore finishes.
  useEffect(() => {
    if (tgStatus.state !== 'starting' && tgStatus.state !== 'restoring') return;
    const t = setInterval(fetchTelegramStatus, 3000);
    return () => clearInterval(t);
  }, [tgStatus.state]);

  const tgAction = async (action: string, body?: any) => {
    setTgActionStatus(`${action}...`);
    setTgResult(null);
    try {
      const res = await fetch(`/api/v1/telegram/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json();
      if (!res.ok) {
        setTgActionStatus('');
        setTgResult({ ok: false, message: data.error || data.message || 'Request failed' });
      } else {
        setTgActionStatus('');
        setTgResult({ ok: true, message: data.message || 'Done', data });
        fetchTelegramStatus();
        fetchTelegramSnapshots();
      }
    } catch (e: any) {
      setTgActionStatus('');
      setTgResult({ ok: false, message: e.message });
    }
  };

  // AI Brain states
  const [aiStatus, setAiStatus] = useState<any>({});
  const [knowledge, setKnowledge] = useState<any[]>([]);
  const [memory, setMemory] = useState<any[]>([]);
  const [knowTitle, setKnowTitle] = useState('');
  const [knowContent, setKnowContent] = useState('');
  const [memKey, setMemKey] = useState('');
  const [memValue, setMemValue] = useState('');
  const [brainMsg, setBrainMsg] = useState('');

  const fetchBrain = async () => {
    try {
      const [s, k, m] = await Promise.all([
        fetch('/api/v1/ai/status').then(r => r.json()),
        fetch('/api/v1/knowledge').then(r => r.json()),
        fetch('/api/v1/memory').then(r => r.json()),
      ]);
      setAiStatus(s);
      setKnowledge(Array.isArray(k) ? k : []);
      setMemory(Array.isArray(m) ? m : []);
    } catch (e) {
      console.error('Failed to fetch brain data:', e);
    }
  };

  useEffect(() => {
    fetchBrain();
  }, []);

  const trainModel = async () => {
    setBrainMsg('Training...');
    try {
      const res = await fetch('/api/v1/ai/train', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Train failed');
      setBrainMsg(`Trained on ${data.stats?.trainedMessages ?? 0} messages. Model ready! ✨`);
      fetchBrain();
    } catch (e: any) {
      setBrainMsg('Error: ' + e.message);
    }
  };

  const addKnowledge = async () => {
    if (!knowContent.trim()) return;
    setBrainMsg('Adding knowledge...');
    try {
      const res = await fetch('/api/v1/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: knowTitle.trim() || 'Untitled', content: knowContent.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setKnowTitle('');
      setKnowContent('');
      setBrainMsg('Knowledge added! 📚');
      fetchBrain();
    } catch (e: any) {
      setBrainMsg('Error: ' + e.message);
    }
  };

  const deleteKnowledge = async (id: number) => {
    try {
      await fetch(`/api/v1/knowledge/${id}`, { method: 'DELETE' });
      fetchBrain();
    } catch (e) {
      console.error(e);
    }
  };

  const addMemory = async () => {
    if (!memKey.trim() || !memValue.trim()) return;
    setBrainMsg('Saving memory...');
    try {
      const res = await fetch('/api/v1/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: memKey.trim(), value: memValue.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setMemKey('');
      setMemValue('');
      setBrainMsg('Memory saved! 🧠');
      fetchBrain();
    } catch (e: any) {
      setBrainMsg('Error: ' + e.message);
    }
  };

  const deleteMemory = async (id: number) => {
    try {
      await fetch(`/api/v1/memory/${id}`, { method: 'DELETE' });
      fetchBrain();
    } catch (e) {
      console.error(e);
    }
  };

  const exportDataset = () => {
    window.location.href = '/api/v1/dataset/export';
  };

  const speak = (text: string) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utterance);
  };

  const modeMeta: Record<string, {icon: string, label: string}> = {
    intent: { icon: '⚙️', label: 'Intent' },
    memory: { icon: '🧠', label: 'Memory' },
    knowledge: { icon: '📚', label: 'Knowledge' },
    generate: { icon: '✍️', label: 'My Model' },
    fallback: { icon: '✨', label: 'Assistant' },
  };

  // AI Chat States
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [chatSessions, setChatSessions] = useState<{id: number, title: string, created_at: string}[]>([]);
  const [messages, setMessages] = useState<{role: 'user' | 'ai', content: string, mode?: string}[]>([
    { role: 'ai', content: "Hello! 👋 I'm your personal AI — fully yours and offline. Ask me anything, or add knowledge and train me in the AI Brain tab." }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Load chat sessions on mount
  useEffect(() => {
    fetch('/api/v1/chats')
      .then(res => res.json())
      .then(data => setChatSessions(data))
      .catch(console.error);
  }, []);

  // Load messages when session changes
  useEffect(() => {
    if (activeSessionId) {
      fetch(`/api/v1/chats/${activeSessionId}/messages`)
        .then(res => res.json())
        .then(data => {
          if (data && data.length > 0) {
            setMessages(data);
          } else {
            setMessages([{ role: 'ai', content: "Hello! 👋 I'm your personal AI — fully yours and offline." }]);
          }
        })
        .catch(console.error);
    } else {
      setMessages([{ role: 'ai', content: "Hello! 👋 I'm your personal AI — fully yours and offline." }]);
    }
  }, [activeSessionId]);

  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping]);

  const createNewSession = async () => {
    try {
      const res = await fetch('/api/v1/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New Chat' })
      });
      const data = await res.json();
      setChatSessions([data, ...chatSessions]);
      setActiveSessionId(data.id);
      return data.id;
    } catch (error) {
      console.error("Failed to create chat session:", error);
      return null;
    }
  };

  const handleSendMessage = async () => {
    if (!chatInput.trim()) return;
    
    const userMsg = chatInput.trim();
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setChatInput('');
    setIsTyping(true);

    try {
      const res = await fetch('/api/v1/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId, message: userMsg })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');

      if (!activeSessionId && data.sessionId) {
        setActiveSessionId(data.sessionId);
        setChatSessions(prev => [{ id: data.sessionId, title: userMsg.slice(0, 30), created_at: '' }, ...prev]);
      }
      setMessages(prev => [...prev, { role: 'ai', content: data.reply, mode: data.mode }]);
    } catch (error: any) {
      setMessages(prev => [...prev, { role: 'ai', content: 'Error: ' + error.message }]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const fetchHealth = async () => {
    try {
      const res = await fetch('/api/v1/health/detailed');
      const data = await res.json();
      setHealthStatus({
        status: data.status,
        api: data.api,
        database: data.database,
        model: data.model,
        telegram: data.telegram
      });
      if (data.stats) {
        setStats({
          totalUsers: data.stats.totalUsers.toString(),
          totalConversations: data.stats.totalConversations.toString(),
          knowledgeDocs: data.stats.knowledgeDocs.toString(),
          datasetCount: data.stats.datasetCount.toString()
        });
      }
    } catch (error) {
      console.error("Failed to fetch health status:", error);
      setHealthStatus({
        status: 'Error',
        api: 'Offline',
        database: 'Offline',
        model: 'Unknown',
        telegram: 'Unknown'
      });
    }
  };

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 10000);
    return () => clearInterval(interval);
  }, []);

  const triggerBackup = async () => {
    setBackupStatus('Backing up...');
    try {
      const res = await fetch('/api/v1/backup', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setBackupStatus('Backup successful!');
      } else {
        setBackupStatus('Error: ' + data.error);
      }
    } catch (error: any) {
      setBackupStatus('Error: ' + error.message);
    }
    setTimeout(() => setBackupStatus(''), 5000);
  };

  const seedDatabase = async () => {
    try {
      await fetch('/api/v1/users/seed', { method: 'POST' });
      fetchHealth();
    } catch (error) {
      console.error(error);
    }
  };

  const navItems = [
    { name: 'Dashboard', icon: <Activity size={18} /> },
    { name: 'AI Chat', icon: <MessageSquare size={18} /> },
    { name: 'AI Brain', icon: <BrainCircuit size={18} /> },
    { name: 'Datasets', icon: <Database size={18} /> },
    { name: 'Telegram Storage', icon: <DatabaseBackup size={18} /> },
    { name: 'Users', icon: <Users size={18} /> },
    { name: 'Settings', icon: <Settings size={18} /> },
  ];

  const renderContent = () => {
    switch (activeTab) {
      case 'Dashboard':
        return (
          <>
            {/* Status Widgets */}
            <div className='col-span-1 md:col-span-3 bg-[#12141C] border border-slate-800/50 rounded-2xl p-5 md:p-6 shadow-xl'>
              <div className='text-xs font-bold text-indigo-400 uppercase tracking-widest mb-4'>API Status</div>
              <div className='text-2xl md:text-3xl font-light text-white mb-2'>{healthStatus.api}</div>
              <div className='mt-4 flex justify-between text-xs text-slate-500 font-mono'><span>Endpoint: /api/v1</span></div>
            </div>
            
            <div className='col-span-1 md:col-span-3 bg-[#12141C] border border-slate-800/50 rounded-2xl p-5 md:p-6 shadow-xl'>
              <div className='text-xs font-bold text-cyan-400 uppercase tracking-widest mb-4'>Database Status</div>
              <div className='text-2xl md:text-3xl font-light text-slate-400 mb-2 truncate'>{healthStatus.database}</div>
              <div className='mt-4 flex justify-between text-xs text-slate-500 font-mono'><span>SQLite / PostgreSQL</span></div>
            </div>

            <div className='col-span-1 md:col-span-3 bg-[#12141C] border border-slate-800/50 rounded-2xl p-5 md:p-6 shadow-xl'>
              <div className='text-xs font-bold text-emerald-400 uppercase tracking-widest mb-4'>Active Model</div>
              <div className='text-2xl md:text-3xl font-light text-white mb-2 truncate'>{healthStatus.model}</div>
              <div className='mt-4 flex justify-between text-xs text-slate-500 font-mono'><span>Type: Local</span></div>
            </div>

            <div className='col-span-1 md:col-span-3 bg-[#12141C] border border-slate-800/50 rounded-2xl p-5 md:p-6 shadow-xl'>
              <div className='text-xs font-bold text-amber-400 uppercase tracking-widest mb-4'>Telegram Storage</div>
              <div className='text-2xl md:text-3xl font-light text-slate-400 mb-2 truncate'>{healthStatus.telegram}</div>
              <div className='mt-4 flex justify-between text-xs text-slate-500 font-mono'><span>Backups: Disabled</span></div>
            </div>

            {/* Statistics Grid */}
            <div className='col-span-1 md:col-span-8 bg-[#12141C] border border-slate-800/50 rounded-2xl p-5 md:p-6 shadow-xl'>
              <div className='text-xs font-bold text-slate-400 uppercase tracking-widest mb-6'>System Metrics</div>
              <div className='grid grid-cols-2 md:grid-cols-4 gap-4'>
                <div className='p-4 bg-slate-800/20 rounded-xl border border-slate-800/50'>
                  <div className='text-xs text-slate-500 mb-1'>Total Users</div>
                  <div className='text-xl text-white'>{stats.totalUsers}</div>
                </div>
                <div className='p-4 bg-slate-800/20 rounded-xl border border-slate-800/50'>
                  <div className='text-xs text-slate-500 mb-1'>Conversations</div>
                  <div className='text-xl text-white'>{stats.totalConversations}</div>
                </div>
                <div className='p-4 bg-slate-800/20 rounded-xl border border-slate-800/50'>
                  <div className='text-xs text-slate-500 mb-1'>Knowledge Docs</div>
                  <div className='text-xl text-white'>{stats.knowledgeDocs}</div>
                </div>
                <div className='p-4 bg-slate-800/20 rounded-xl border border-slate-800/50'>
                  <div className='text-xs text-slate-500 mb-1'>Dataset Count</div>
                  <div className='text-xl text-white'>{stats.datasetCount}</div>
                </div>
              </div>
              <div className='mt-6 p-4 bg-indigo-500/10 border border-indigo-500/20 rounded-xl flex justify-between items-center'>
                  <div>
                    <div className='text-sm font-medium text-indigo-300'>Info</div>
                    <div className='text-xs text-indigo-400/80 mt-1'>Data is loaded from myai.db. You can test insertion with the button.</div>
                  </div>
                  <button onClick={seedDatabase} className='px-4 py-2 bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 rounded-lg text-xs font-medium transition-colors'>
                    Seed Test User
                  </button>
              </div>
            </div>
            
            {/* Quick Actions / Logs */}
            <div className='col-span-1 md:col-span-4 bg-[#12141C] border border-slate-800/50 rounded-2xl p-5 md:p-6 shadow-xl flex flex-col'>
              <div className='text-xs font-bold text-white uppercase tracking-widest mb-6'>Quick Actions</div>
              <div className='flex-1 flex flex-col space-y-3 mb-4'>
                <button 
                  onClick={triggerBackup}
                  className='w-full py-4 bg-slate-800/40 hover:bg-slate-800/60 text-emerald-400 border border-emerald-500/20 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all'>
                  <DatabaseBackup size={18} />
                  Backup DB to Telegram
                </button>
                {backupStatus && (
                  <div className='text-center text-xs text-slate-400 p-2 bg-slate-800/20 rounded-lg'>{backupStatus}</div>
                )}
              </div>
              <button 
                onClick={() => alert('Not implemented yet')}
                className='w-full py-3 bg-indigo-600/10 hover:bg-indigo-600/20 text-indigo-400 border border-indigo-500/20 rounded-xl text-xs font-bold uppercase tracking-widest transition-all mt-auto'>
                View All Logs
              </button>
            </div>
          </>
        );
      case 'AI Chat':
        return (
          <div className='col-span-1 md:col-span-12 flex h-[80vh] md:h-full bg-[#131314] rounded-2xl border border-slate-800/50 overflow-hidden shadow-2xl relative'>
            
            {/* Chat History Sidebar */}
            <div className='w-64 border-r border-slate-800/50 flex flex-col hidden md:flex shrink-0'>
              <div className='p-4 border-b border-slate-800/50 flex justify-between items-center'>
                <h3 className='text-sm font-medium text-slate-300'>Chat History</h3>
                <button 
                  onClick={() => {
                    setActiveSessionId(null);
                    setMessages([{ role: 'ai', content: 'Hello! I am your personal AI. Ready to chat when you are.' }]);
                  }}
                  className='p-1.5 hover:bg-slate-800/50 rounded-lg text-slate-400 hover:text-white transition-colors'
                  title="New Chat"
                >
                  <MessageSquare size={16} />
                </button>
              </div>
              <div className='flex-1 overflow-y-auto p-2 space-y-1'>
                {chatSessions.map((session) => (
                  <button
                    key={session.id}
                    onClick={() => setActiveSessionId(session.id)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg text-sm truncate transition-colors ${
                      activeSessionId === session.id 
                        ? 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/20' 
                        : 'text-slate-400 hover:bg-slate-800/30'
                    }`}
                  >
                    {session.title}
                  </button>
                ))}
                {chatSessions.length === 0 && (
                  <div className='text-xs text-slate-500 text-center p-4'>No chats yet</div>
                )}
              </div>
            </div>

            {/* Main Chat Area */}
            <div className='flex-1 flex flex-col min-w-0'>
              {/* Mobile session selector (sidebar is hidden on small screens) */}
              {chatSessions.length > 0 && (
                <div className='md:hidden px-3 pt-3 flex gap-2 overflow-x-auto pb-1 shrink-0'>
                  <button
                    onClick={() => { setActiveSessionId(null); setMessages([{ role: 'ai', content: "Hello! 👋 I'm your personal AI — fully yours and offline." }]); }}
                    className={`px-3 py-1.5 rounded-full text-xs whitespace-nowrap border ${activeSessionId === null ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' : 'bg-slate-800/40 text-slate-400 border-slate-700/50'}`}
                  >
                    + New
                  </button>
                  {chatSessions.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setActiveSessionId(s.id)}
                      className={`px-3 py-1.5 rounded-full text-xs whitespace-nowrap border ${activeSessionId === s.id ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' : 'bg-slate-800/40 text-slate-400 border-slate-700/50'}`}
                    >
                      {s.title}
                    </button>
                  ))}
                </div>
              )}

              {/* Chat Messages Area */}
              <div className='flex-1 overflow-y-auto p-4 md:p-8 space-y-6'>
                {messages.map((msg, idx) => (
                <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'ai' && (
                    <div className='w-8 h-8 rounded-full bg-indigo-500/20 flex items-center justify-center mr-4 mt-1 flex-shrink-0'>
                      <Sparkles size={16} className='text-indigo-400' />
                    </div>
                  )}
                  <div className={`max-w-[85%] md:max-w-[70%] ${
                    msg.role === 'user' 
                      ? 'bg-slate-800/80 text-slate-200 px-5 py-3 rounded-2xl rounded-tr-sm' 
                      : 'text-slate-300 py-1'
                  }`}>
                    <div className='text-[15px] leading-relaxed whitespace-pre-wrap'>{msg.content}</div>
                    {msg.role === 'ai' && (
                      <div className='mt-1.5 flex items-center gap-2'>
                        {msg.mode && modeMeta[msg.mode] && (
                          <span className='inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-500 bg-slate-800/50 border border-slate-700/50 px-2 py-0.5 rounded-full'>
                            {modeMeta[msg.mode].icon} {modeMeta[msg.mode].label}
                          </span>
                        )}
                        <button
                          onClick={() => speak(msg.content)}
                          className='p-1 text-slate-500 hover:text-slate-200 transition-colors rounded-full hover:bg-slate-800/50'
                          title='Speak'
                        >
                          <Volume2 size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              
              {isTyping && (
                <div className='flex justify-start'>
                  <div className='w-8 h-8 rounded-full bg-indigo-500/20 flex items-center justify-center mr-4 flex-shrink-0'>
                    <Sparkles size={16} className='text-indigo-400' />
                  </div>
                  <div className='flex space-x-2 items-center py-3'>
                    <div className='w-2 h-2 bg-indigo-500/50 rounded-full animate-bounce' style={{ animationDelay: '0ms' }}></div>
                    <div className='w-2 h-2 bg-indigo-500/50 rounded-full animate-bounce' style={{ animationDelay: '150ms' }}></div>
                    <div className='w-2 h-2 bg-indigo-500/50 rounded-full animate-bounce' style={{ animationDelay: '300ms' }}></div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input Area */}
            <div className='p-4 md:p-6 bg-gradient-to-t from-[#131314] via-[#131314] to-transparent shrink-0'>
              <div className='max-w-4xl mx-auto'>
                <div className='relative bg-[#1E1F22] rounded-3xl border border-slate-700/50 flex items-end p-2 px-4 shadow-lg focus-within:ring-1 focus-within:ring-slate-600 focus-within:border-slate-600 transition-all'>
                  
                  <button className='p-2 md:p-3 text-slate-400 hover:text-slate-200 transition-colors rounded-full hover:bg-slate-800/50 flex-shrink-0 mb-1'>
                    <Paperclip size={20} />
                  </button>
                  
                  <textarea 
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Message MY-AI..."
                    className='w-full bg-transparent text-slate-200 placeholder-slate-500 border-none focus:ring-0 resize-none max-h-32 min-h-[44px] py-3 px-2 outline-none text-[15px]'
                    rows={1}
                  />
                  
                  <div className='flex items-center gap-1 mb-1'>
                    {!chatInput.trim() && (
                      <button className='p-2 md:p-3 text-slate-400 hover:text-slate-200 transition-colors rounded-full hover:bg-slate-800/50 flex-shrink-0'>
                        <Mic size={20} />
                      </button>
                    )}
                    <button 
                      onClick={handleSendMessage}
                      disabled={!chatInput.trim()}
                      className={`p-2 md:p-3 rounded-full transition-colors flex-shrink-0 ${
                        chatInput.trim() 
                          ? 'bg-slate-200 text-slate-900 hover:bg-white' 
                          : 'bg-transparent text-slate-600'
                      }`}>
                      <Send size={18} className={chatInput.trim() ? 'ml-0.5' : ''} />
                    </button>
                  </div>
                </div>
                <div className='text-center mt-3 text-[11px] text-slate-500 font-medium'>
                  MY-AI can make mistakes. Consider verifying important information.
                </div>
              </div>
            </div>
            </div>
          </div>
        );
      case 'Telegram Storage': {
        const state: string = tgStatus.state || 'starting';
        const stateInfo: Record<string, { label: string; cls: string; dot: string }> = {
          ready: { label: 'Ready', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', dot: 'bg-emerald-400' },
          restoring: { label: 'Restoring…', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30', dot: 'bg-amber-400 animate-pulse' },
          starting: { label: 'Starting…', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30', dot: 'bg-sky-400 animate-pulse' },
          restore_failed: { label: 'Restore Failed', cls: 'bg-red-500/10 text-red-300 border-red-500/30', dot: 'bg-red-400' },
        };
        const si = stateInfo[state] || stateInfo.starting;
        const fmt = (iso?: string | null) => {
          if (!iso) return 'Never';
          const d = new Date(iso);
          if (isNaN(d.getTime())) return 'Never';
          const mins = Math.round((Date.now() - d.getTime()) / 60000);
          const rel = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
          return `${d.toLocaleString()} (${rel})`;
        };
        const busy = !!tgActionStatus || tgStatus.snapshotInProgress || tgStatus.restoreInProgress;
        return (
          <>
            {/* App state + connection */}
            <div className='col-span-1 md:col-span-12 bg-[#12141C] border border-slate-800/50 rounded-2xl p-4 md:p-6 shadow-xl'>
              <div className='flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4'>
                <div className='min-w-0'>
                  <div className='text-xs font-bold text-amber-400 uppercase tracking-widest mb-2'>Telegram Cloud Database</div>
                  <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm font-semibold ${si.cls}`}>
                    <span className={`w-2 h-2 rounded-full ${si.dot}`} />
                    {si.label}
                  </div>
                  <div className='mt-3 text-xs text-slate-500 font-mono space-y-1 break-words'>
                    <div>Connection: {tgStatus.configured ? '✅ configured' : '❌ not configured'}</div>
                    <div>Bot Token: {tgStatus.botTokenSet ? '✅ set' : '❌ missing'} · Channel ID: {tgStatus.chatIdSet ? '✅ set' : '❌ missing'}</div>
                    {tgStatus.botUsername && <div>Bot: @{tgStatus.botUsername}</div>}
                    {tgStatus.channelTitle && <div>Channel: {tgStatus.channelTitle}</div>}
                    <div>Indexed records: {tgStatus.indexedRecords ?? '...'}</div>
                  </div>
                </div>
                <button
                  onClick={() => tgAction('verify')}
                  className='w-full sm:w-auto shrink-0 px-5 py-3 bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-300 border border-emerald-500/30 rounded-xl text-sm font-medium transition-colors'>
                  Verify Connection
                </button>
              </div>
              {state === 'restore_failed' && (
                <div className='mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-300 break-words'>
                  ⚠️ Restore failed — your local data was NOT modified and the Telegram bot is paused.
                  {tgStatus.lastError && <div className='mt-1 font-mono text-[10px] opacity-80'>{tgStatus.lastError}</div>}
                </div>
              )}
              {state === 'restoring' && (
                <div className='mt-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-300'>
                  ♻️ Restoring your AI data from the Telegram channel. Chat requests return 503 until this finishes.
                </div>
              )}
            </div>

            {/* Backup / restore summary — mobile friendly cards */}
            <div className='col-span-1 md:col-span-12 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 md:gap-4'>
              <div className='bg-[#12141C] border border-slate-800/50 rounded-2xl p-4'>
                <div className='text-[10px] font-bold text-slate-500 uppercase tracking-widest'>Last Backup</div>
                <div className='mt-2 text-sm text-white break-words'>{fmt(tgStatus.lastSnapshotAt)}</div>
              </div>
              <div className='bg-[#12141C] border border-slate-800/50 rounded-2xl p-4'>
                <div className='text-[10px] font-bold text-slate-500 uppercase tracking-widest'>Last Restore</div>
                <div className='mt-2 text-sm text-white break-words'>{fmt(tgStatus.lastRestoreAt)}</div>
              </div>
              <div className='bg-[#12141C] border border-slate-800/50 rounded-2xl p-4'>
                <div className='text-[10px] font-bold text-slate-500 uppercase tracking-widest'>Auto Backup</div>
                <div className='mt-2 text-sm text-white'>
                  {tgStatus.autoSnapshotEnabled ? `On · every ${tgStatus.snapshotIntervalMinutes ?? 30} min` : 'Off'}
                </div>
                <div className='mt-1 text-[10px] text-slate-500 break-words'>Next: {fmt(tgStatus.nextSnapshotAt)}</div>
              </div>
              <div className='bg-[#12141C] border border-slate-800/50 rounded-2xl p-4'>
                <div className='text-[10px] font-bold text-slate-500 uppercase tracking-widest'>Auto Restore</div>
                <div className='mt-2 text-sm text-white'>{tgStatus.autoRestoreEnabled ? 'On at startup' : 'Off'}</div>
                <div className='mt-1 text-[10px] text-slate-500'>
                  {tgStatus.restoreOnEmptyOnly ? 'Only when the local DB is empty' : 'Always on startup'}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className='col-span-1 md:col-span-6 bg-[#12141C] border border-slate-800/50 rounded-2xl p-4 md:p-6 shadow-xl'>
              <div className='text-xs font-bold text-white uppercase tracking-widest mb-4'>Cloud Actions</div>
              <div className='space-y-3'>
                <button
                  onClick={() => tgAction('snapshot', { force: true })}
                  disabled={busy}
                  className='w-full py-3.5 bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-200 border border-indigo-500/30 rounded-xl text-sm font-bold transition-all disabled:opacity-50'>
                  📦 Backup Now
                </button>
                <button
                  onClick={() => {
                    if (confirm('Restore the latest Telegram snapshot? This replaces the current local database.')) {
                      tgAction('restore', { force: true });
                    }
                  }}
                  disabled={busy}
                  className='w-full py-3.5 bg-amber-600/20 hover:bg-amber-600/40 text-amber-200 border border-amber-500/30 rounded-xl text-sm font-bold transition-all disabled:opacity-50'>
                  ♻️ Restore Latest
                </button>
                <button
                  onClick={() => tgAction('sync')}
                  disabled={busy}
                  className='w-full py-3 bg-slate-800/40 hover:bg-slate-800/60 text-cyan-300 border border-cyan-500/20 rounded-xl text-sm font-medium transition-all disabled:opacity-50'>
                  🔄 Mirror All Records to Telegram
                </button>
                <a
                  href='/api/v1/telegram/snapshot/download'
                  className='block w-full py-3 text-center bg-slate-800/40 hover:bg-slate-800/60 text-slate-300 border border-slate-700/50 rounded-xl text-sm font-medium transition-all'>
                  ⬇️ Download Snapshot (JSON)
                </a>
              </div>
              {tgActionStatus && (
                <div className='mt-4 text-center text-xs text-slate-400 p-2 bg-slate-800/20 rounded-lg'>{tgActionStatus}</div>
              )}
              {tgResult && (
                <div className={`mt-4 text-xs p-3 rounded-lg break-words ${tgResult.ok ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20' : 'bg-red-500/10 text-red-300 border border-red-500/20'}`}>
                  {tgResult.message}
                  {tgResult.data?.checksum && (
                    <div className='mt-2 font-mono text-[10px] text-slate-400 break-all'>checksum: {tgResult.data.checksum}</div>
                  )}
                  {tgResult.data?.fileId && (
                    <div className='mt-1 font-mono text-[10px] text-slate-400 break-all'>fileId: {tgResult.data.fileId}</div>
                  )}
                </div>
              )}
            </div>

            {/* Stored data + snapshots */}
            <div className='col-span-1 md:col-span-6 bg-[#12141C] border border-slate-800/50 rounded-2xl p-4 md:p-6 shadow-xl'>
              <div className='text-xs font-bold text-white uppercase tracking-widest mb-4'>Backed-up Tables</div>
              {tgStatus.tableCounts ? (
                <div className='grid grid-cols-2 gap-2 mb-5'>
                  {Object.entries(tgStatus.tableCounts as Record<string, number>).map(([t, n]) => (
                    <div key={t} className='px-3 py-2 bg-slate-800/20 rounded-lg border border-slate-800/50'>
                      <div className='text-[10px] text-slate-500 font-mono truncate'>{t}</div>
                      <div className='text-sm text-white font-semibold'>{n}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className='text-xs text-slate-500 mb-5'>Loading…</div>
              )}
              <div className='text-xs font-bold text-white uppercase tracking-widest mb-3'>Snapshots</div>
              {tgSnapshots.length === 0 ? (
                <div className='text-xs text-slate-500 text-center p-4'>No snapshots yet. Press “Backup Now”.</div>
              ) : (
                <div className='space-y-2 max-h-56 overflow-y-auto'>
                  {tgSnapshots.map((s: any) => (
                    <div key={s.id} className='p-3 bg-slate-800/20 rounded-lg border border-slate-800/50'>
                      <div className='text-[10px] text-slate-300 font-mono break-all'>{s.telegram_file_id}</div>
                      <div className='mt-1 flex items-center justify-between gap-2'>
                        <span className='text-[10px] text-slate-500'>msg {s.telegram_message_id} · {s.created_at}</span>
                        <button
                          onClick={() => tgAction('restore', { fileId: s.telegram_file_id, force: true })}
                          disabled={busy}
                          className='shrink-0 px-2 py-1 text-[10px] bg-amber-600/20 hover:bg-amber-600/40 text-amber-300 border border-amber-500/30 rounded-md disabled:opacity-50'>
                          Restore
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* How it works */}
            <div className='col-span-1 md:col-span-12 p-4 bg-cyan-500/10 border border-cyan-500/20 rounded-2xl'>
              <div className='text-sm font-medium text-cyan-300'>📱 How your data stays safe</div>
              <div className='text-xs text-cyan-400/80 mt-2 space-y-1'>
                <div>• The Telegram private channel is the <b>permanent database</b> — Render's SQLite disk is only a temporary cache.</div>
                <div>• After every restart, redeploy or wake-from-sleep, the latest snapshot is restored automatically before the bot starts.</div>
                <div>• The same bot is also your AI assistant — message it in Telegram and your AI replies.</div>
              </div>
            </div>
          </>
        );
      }
      case 'AI Brain':
        return (
          <>
            {/* Model status + actions */}
            <div className='col-span-1 md:col-span-12 bg-[#12141C] border border-slate-800/50 rounded-2xl p-6 shadow-xl'>
              <div className='flex flex-wrap items-center justify-between gap-4'>
                <div>
                  <div className='text-xs font-bold text-indigo-400 uppercase tracking-widest mb-2'>Local AI Model</div>
                  <div className='text-xl md:text-2xl font-light text-white'>
                    {aiStatus.trained ? 'Trained ✓' : 'Not trained yet'}
                  </div>
                  <div className='mt-2 text-xs text-slate-500 font-mono'>
                    Messages: {aiStatus.corpusMessages ?? '...'} · Knowledge: {aiStatus.knowledgeDocs ?? '...'} · Memory: {aiStatus.memoryFacts ?? '...'}
                    {aiStatus.trained && <> · Chains: {aiStatus.modelChains} · Vocab: {aiStatus.vocabSize}</>}
                  </div>
                </div>
                <div className='flex gap-3'>
                  <button onClick={trainModel} className='px-5 py-3 bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 rounded-xl text-sm font-medium transition-colors flex items-center gap-2'>
                    <Play size={16} /> Train on My Messages
                  </button>
                  <button onClick={exportDataset} className='px-5 py-3 bg-slate-800/40 hover:bg-slate-800/60 text-cyan-300 border border-cyan-500/20 rounded-xl text-sm font-medium transition-colors flex items-center gap-2'>
                    <Download size={16} /> Export Dataset
                  </button>
                </div>
              </div>
              {brainMsg && <div className='mt-4 text-xs text-slate-300 p-3 bg-slate-800/30 rounded-lg'>{brainMsg}</div>}
            </div>

            {/* Knowledge manager */}
            <div className='col-span-1 md:col-span-6 bg-[#12141C] border border-slate-800/50 rounded-2xl p-6 shadow-xl'>
              <div className='text-xs font-bold text-white uppercase tracking-widest mb-4'>Knowledge 📚</div>
              <div className='space-y-2 mb-4'>
                <input
                  value={knowTitle}
                  onChange={(e) => setKnowTitle(e.target.value)}
                  placeholder='Title'
                  className='w-full bg-slate-800/40 border border-slate-700/50 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-indigo-500/50'
                />
                <textarea
                  value={knowContent}
                  onChange={(e) => setKnowContent(e.target.value)}
                  placeholder='Paste your notes, documents, or anything the AI should know...'
                  rows={3}
                  className='w-full bg-slate-800/40 border border-slate-700/50 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-indigo-500/50 resize-none'
                />
                <button onClick={addKnowledge} className='w-full py-2 bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 rounded-lg text-sm font-medium transition-colors'>
                  Add Knowledge
                </button>
              </div>
              <div className='space-y-2 max-h-56 overflow-y-auto'>
                {knowledge.length === 0 && <div className='text-xs text-slate-500 text-center p-4'>No knowledge yet. Add your documents above.</div>}
                {knowledge.map((k: any) => (
                  <div key={k.id} className='p-3 bg-slate-800/20 rounded-lg border border-slate-800/50 flex justify-between items-start gap-2'>
                    <div className='min-w-0'>
                      <div className='text-xs font-medium text-slate-200 truncate'>{k.title}</div>
                      <div className='text-[11px] text-slate-500 truncate mt-0.5'>{k.content.slice(0, 80)}</div>
                    </div>
                    <button onClick={() => deleteKnowledge(k.id)} className='p-1.5 text-slate-500 hover:text-red-400 transition-colors shrink-0'>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Memory manager */}
            <div className='col-span-1 md:col-span-6 bg-[#12141C] border border-slate-800/50 rounded-2xl p-6 shadow-xl'>
              <div className='text-xs font-bold text-white uppercase tracking-widest mb-4'>Memory 🧠</div>
              <div className='flex gap-2 mb-4'>
                <input
                  value={memKey}
                  onChange={(e) => setMemKey(e.target.value)}
                  placeholder='Key (e.g. name)'
                  className='flex-1 bg-slate-800/40 border border-slate-700/50 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-indigo-500/50'
                />
                <input
                  value={memValue}
                  onChange={(e) => setMemValue(e.target.value)}
                  placeholder='Value'
                  className='flex-1 bg-slate-800/40 border border-slate-700/50 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-indigo-500/50'
                />
                <button onClick={addMemory} className='px-3 py-2 bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 rounded-lg text-sm font-medium transition-colors shrink-0'>
                  Save
                </button>
              </div>
              <div className='space-y-2 max-h-56 overflow-y-auto'>
                {memory.length === 0 && <div className='text-xs text-slate-500 text-center p-4'>No memories yet. Try telling the AI "My name is ..." in chat.</div>}
                {memory.map((m: any) => (
                  <div key={m.id} className='p-3 bg-slate-800/20 rounded-lg border border-slate-800/50 flex justify-between items-center gap-2'>
                    <div className='min-w-0'>
                      <div className='text-xs font-medium text-slate-200 truncate'>{m.key}</div>
                      <div className='text-[11px] text-slate-500 truncate mt-0.5'>{m.value}</div>
                    </div>
                    <button onClick={() => deleteMemory(m.id)} className='p-1.5 text-slate-500 hover:text-red-400 transition-colors shrink-0'>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </>
        );
      default:
        return (
          <div className='col-span-1 md:col-span-12 bg-[#12141C] border border-slate-800/50 rounded-2xl p-10 shadow-xl flex flex-col items-center justify-center text-center min-h-[400px]'>
            <div className='w-16 h-16 bg-slate-800/50 rounded-full flex items-center justify-center mb-6 text-slate-500'>
              {navItems.find(i => i.name === activeTab)?.icon}
            </div>
            <h2 className='text-2xl font-light text-white mb-3'>{activeTab}</h2>
            <p className='text-slate-400 max-w-md'>
              {activeTab === 'Datasets' ? 'Use "AI Brain → Export Dataset" to download your chat data as a training dataset (JSONL).' :
               activeTab === 'Users' ? 'User management is coming soon.' :
               activeTab === 'Settings' ? 'Settings are coming soon.' :
               'Not implemented yet.'}
            </p>
            <button 
              onClick={() => setActiveTab('Dashboard')}
              className='mt-8 px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors'>
              Return to Dashboard
            </button>
          </div>
        );
    }
  };

  return (
    <div className='flex min-h-screen w-full bg-[#0A0B10] text-slate-300 font-sans overflow-hidden'>
      {/* Mobile menu overlay */}
      {isMobileMenuOpen && (
        <div 
          className="fixed inset-0 bg-black/60 z-40 md:hidden backdrop-blur-sm" 
          onClick={() => setIsMobileMenuOpen(false)} 
        />
      )}

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-64 bg-[#0F1117] border-r border-slate-800/50 flex flex-col transform transition-transform duration-300 ease-in-out md:relative md:translate-x-0 ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className='p-6 md:p-8 mb-4 flex items-center justify-between'>
          <div className='flex items-center gap-3'>
            <div className='w-8 h-8 bg-gradient-to-br from-indigo-500 to-cyan-400 rounded-lg shadow-lg shadow-indigo-500/20 flex items-center justify-center'>
              <span className='text-white font-bold'>AI</span>
            </div>
            <span className='text-xl font-bold tracking-tight text-white'>MY<span className='text-indigo-400'>-AI</span></span>
          </div>
          <button className="md:hidden text-slate-400 hover:text-white" onClick={() => setIsMobileMenuOpen(false)}>
            <X size={20} />
          </button>
        </div>
        <nav className='flex-1 px-4 space-y-1 overflow-y-auto pb-4'>
          {navItems.map((item, index) => {
            const isActive = activeTab === item.name;
            return (
              <div 
                key={index} 
                onClick={() => {
                  setActiveTab(item.name);
                  setIsMobileMenuOpen(false);
                }}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors cursor-pointer ${isActive ? 'bg-slate-800/40 text-white border border-slate-700/50 shadow-sm' : 'hover:bg-slate-800/30 text-slate-400'}`}>
                {isActive && <span className='w-2 h-2 rounded-full bg-indigo-400 shadow-[0_0_8px_rgba(129,140,248,0.6)] absolute ml-[-12px]'></span>}
                {item.icon}
                {item.name}
              </div>
            );
          })}
        </nav>
        <div className='p-6 border-t border-slate-800/50'>
          <div className='bg-slate-800/30 p-4 rounded-xl border border-slate-700/50'>
            <div className='text-xs text-slate-500 uppercase tracking-widest mb-2 font-semibold'>System Status</div>
            <div className='flex justify-between items-center'><span className='text-sm font-medium'>{healthStatus.status}</span><span className={`text-xs ${healthStatus.status === 'Operational' ? 'text-emerald-400' : 'text-amber-400'}`}>API</span></div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className='flex-1 flex flex-col min-w-0'>
        <header className='h-20 px-4 md:px-8 border-b border-slate-800/50 flex items-center justify-between bg-[#0A0B10]/80 backdrop-blur-md z-10'>
          <div className="flex items-center gap-3">
            <button className="md:hidden p-2 -ml-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800/50" onClick={() => setIsMobileMenuOpen(true)}>
              <Menu size={24} />
            </button>
            <div>
              <h1 className='text-lg md:text-2xl font-semibold text-white tracking-tight truncate'>
                {activeTab === 'Dashboard' ? 'Control Panel' : activeTab}
              </h1>
              <p className='text-xs md:text-sm text-slate-500 hidden sm:block'>Admin Dashboard - MY-AI</p>
            </div>
          </div>
          <div className='flex items-center gap-2 md:gap-4'>
            <div className='bg-slate-800/50 px-3 md:px-4 py-1.5 md:py-2 rounded-full text-[10px] md:text-xs font-mono text-slate-400 border border-slate-700/50 hidden sm:block'>Admin Mode</div>
            <div className='w-8 h-8 md:w-10 md:h-10 rounded-full bg-gradient-to-tr from-slate-700 to-slate-500 border border-slate-600 shadow-inner flex-shrink-0'></div>
          </div>
        </header>
        
        <section className={`flex-1 overflow-y-auto content-start ${activeTab === 'AI Chat' ? 'p-4 md:p-6 flex flex-col' : 'p-4 md:p-8 grid grid-cols-1 md:grid-cols-12 grid-rows-none gap-4 md:gap-6'}`}>
          {renderContent()}
        </section>
      </main>
    </div>
  );
}
