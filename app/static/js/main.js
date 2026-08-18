document.addEventListener('DOMContentLoaded', () => {
    // Theme toggle
    const toggleBtn = document.getElementById('theme-toggle');
    const htmlEl = document.documentElement;
    
    // Check local storage or system preference
    if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        htmlEl.classList.add('dark');
    } else {
        htmlEl.classList.remove('dark');
    }

    toggleBtn.addEventListener('click', () => {
        if (htmlEl.classList.contains('dark')) {
            htmlEl.classList.remove('dark');
            localStorage.theme = 'light';
        } else {
            htmlEl.classList.add('dark');
            localStorage.theme = 'dark';
        }
    });

    // Fetch API Health
    fetch('/api/v1/health')
        .then(response => response.json())
        .then(data => {
            const statusEl = document.getElementById('api-status');
            if (statusEl) {
                if (data.status === 'ok') {
                    statusEl.textContent = 'Online';
                    statusEl.className = 'text-2xl font-semibold text-green-500 mt-2';
                } else {
                    statusEl.textContent = 'Degraded';
                    statusEl.className = 'text-2xl font-semibold text-red-500 mt-2';
                }
            }
        })
        .catch(err => {
            const statusEl = document.getElementById('api-status');
            if (statusEl) {
                statusEl.textContent = 'Offline';
                statusEl.className = 'text-2xl font-semibold text-red-500 mt-2';
            }
        });
});
