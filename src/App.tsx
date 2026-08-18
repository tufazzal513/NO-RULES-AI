/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { Menu, X, Activity, Database, BrainCircuit, MessageSquare, DatabaseBackup, Users, Settings } from 'lucide-react';

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
    { name: 'Models', icon: <BrainCircuit size={18} /> },
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
      default:
        return (
          <div className='col-span-1 md:col-span-12 bg-[#12141C] border border-slate-800/50 rounded-2xl p-10 shadow-xl flex flex-col items-center justify-center text-center min-h-[400px]'>
            <div className='w-16 h-16 bg-slate-800/50 rounded-full flex items-center justify-center mb-6 text-slate-500'>
              {navItems.find(i => i.name === activeTab)?.icon}
            </div>
            <h2 className='text-2xl font-light text-white mb-3'>{activeTab}</h2>
            <p className='text-slate-400 max-w-md'>
              {activeTab === 'AI Chat' ? 'AI core and model interfaces are pending implementation (Phase 2 & 3).' :
               activeTab === 'Telegram Storage' ? 'Configuration required. Please provide TELEGRAM_BOT_TOKEN and TELEGRAM_STORAGE_CHAT_ID.' :
               activeTab === 'Datasets' ? 'Dataset management module is pending implementation (Phase 13).' :
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
        
        <section className='p-4 md:p-8 flex-1 grid grid-cols-1 md:grid-cols-12 grid-rows-none gap-4 md:gap-6 overflow-y-auto content-start'>
          {renderContent()}
        </section>
      </main>
    </div>
  );
}
