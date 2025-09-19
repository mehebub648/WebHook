// Enhanced Request Page JavaScript
// Handles client-side navigation, pagination, and request management

class RequestManager {
  constructor() {
    this.currentPage = 1;
    this.pageSize = 10;
    this.allRequests = [];
    this.filteredRequests = [];
    this.selectedRid = null;
    this.webhookId = null;
    this.socket = null;
    this.isLoading = false;
    
    this.init();
  }
  
  init() {
    // Get webhook ID from the page
    this.webhookId = this.getWebhookId();
    
    // Load initial data
    this.loadRequests();
    
    // Setup event listeners
    this.setupEventListeners();
    
    // Setup WebSocket if available
    this.setupSocket();
    
    // Setup pagination
    this.setupPagination();
  }
  
  getWebhookId() {
    // Extract webhook ID from URL or page content
    const match = window.location.pathname.match(/\/request\/([^\/]+)/);
    return match ? match[1] : null;
  }
  
  async loadRequests() {
    if (!this.webhookId) return;
    
    this.setLoading(true);
    try {
      const response = await fetch(`/api/requests/${this.webhookId}`);
      if (response.ok) {
        const data = await response.json();
        this.allRequests = data.requests || [];
        this.applyFilters();
        this.renderRequestList();
        
        // Select first request if none selected
        if (!this.selectedRid && this.filteredRequests.length > 0) {
          this.selectRequest(this.filteredRequests[0].rid);
        }
      }
    } catch (error) {
      console.error('Failed to load requests:', error);
      this.showToast('Failed to load requests', 'error');
    } finally {
      this.setLoading(false);
    }
  }
  
  async loadRequestDetails(rid) {
    if (!rid || !this.webhookId) return;
    
    this.setLoading(true);
    try {
      const response = await fetch(`/api/requests/${this.webhookId}/${rid}`);
      if (response.ok) {
        const request = await response.json();
        this.renderRequestDetails(request);
        
        // Update URL without page refresh
        const newUrl = `/request/${this.webhookId}?rid=${encodeURIComponent(rid)}`;
        window.history.pushState({ rid }, '', newUrl);
      }
    } catch (error) {
      console.error('Failed to load request details:', error);
      this.showToast('Failed to load request details', 'error');
    } finally {
      this.setLoading(false);
    }
  }
  
  selectRequest(rid) {
    if (this.selectedRid === rid) return;
    
    // Update selected state in UI
    const prevSelected = document.querySelector('.request-item.active');
    if (prevSelected) {
      prevSelected.classList.remove('active');
    }
    
    const newSelected = document.querySelector(`[data-rid="${rid}"]`);
    if (newSelected) {
      newSelected.classList.add('active');
      // Scroll into view
      newSelected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    
    this.selectedRid = rid;
    this.loadRequestDetails(rid);
  }
  
  applyFilters() {
    const filterInput = document.getElementById('reqFilter');
    const query = filterInput ? filterInput.value.toLowerCase().trim() : '';
    
    if (!query) {
      this.filteredRequests = [...this.allRequests];
    } else {
      this.filteredRequests = this.allRequests.filter(request => {
        const searchText = [
          request.method || '',
          request.path || request.full_url || '',
          request.response_status || '',
          request.ip || '',
          request.user_agent || ''
        ].join(' ').toLowerCase();
        
        return searchText.includes(query);
      });
    }
    
    // Reset pagination when filtering
    this.currentPage = 1;
    this.updateRequestCount();
  }
  
  renderRequestList() {
    const container = document.querySelector('.request-list-container');
    if (!container) return;
    
    // Calculate pagination
    const startIndex = (this.currentPage - 1) * this.pageSize;
    const endIndex = startIndex + this.pageSize;
    const pageRequests = this.filteredRequests.slice(startIndex, endIndex);
    
    if (pageRequests.length === 0) {
      container.innerHTML = '<div class="px-4 py-6 text-slate-600">No requests found.</div>';
      return;
    }
    
    const html = pageRequests.map(request => this.createRequestListItem(request)).join('');
    container.innerHTML = html;
    
    // Add click handlers
    container.querySelectorAll('.request-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const rid = item.dataset.rid;
        if (rid) {
          this.selectRequest(rid);
        }
      });
    });
    
    this.updatePagination();
  }
  
  createRequestListItem(request) {
    const isActive = this.selectedRid === request.rid;
    const requestTime = new Date(request.time).toLocaleString();
    const forwardingStatus = this.getForwardingStatus(request);
    
    return `
      <div class="request-item ${isActive ? 'active' : ''}" data-rid="${request.rid}">
        <div class="flex items-center gap-2 text-sm">
          <span class="chip font-mono text-xs">${request.method || ''}</span>
          <span class="text-slate-500 font-mono text-xs">${requestTime}</span>
          ${request.response_status ? `
            <span class="ml-auto inline-flex items-center gap-1 text-xs text-slate-500">
              <span class="icon-signal"></span>${request.response_status}
            </span>
          ` : ''}
        </div>
        <div class="font-mono text-slate-600 text-xs mt-1 break-all">${request.path || request.full_url || ''}</div>
        ${forwardingStatus ? `<div class="mt-1">${forwardingStatus}</div>` : ''}
      </div>
    `;
  }
  
  getForwardingStatus(request) {
    if (request.proxied_status) {
      return `<span class="forwarding-status success">Forwarded: ${request.proxied_status}</span>`;
    } else if (request.proxy_error) {
      return `<span class="forwarding-status error">Forward failed: ${request.proxy_error}</span>`;
    } else if (request.destination) {
      return `<span class="forwarding-status pending">Forwarding...</span>`;
    }
    return '';
  }
  
  renderRequestDetails(request) {
    const detailsContainer = document.querySelector('.request-details-container');
    if (!detailsContainer) return;
    
    const prettyHeaders = JSON.stringify(request.headers || {}, null, 2);
    const prettyQuery = JSON.stringify(request.query || {}, null, 2);
    let prettyBody = request.body || '';
    try {
      const decoded = JSON.parse(request.body);
      prettyBody = JSON.stringify(decoded, null, 2);
    } catch (e) { /* leave as-is */ }
    
    const respStatus = request.response_status || 200;
    const requestTime = new Date(request.time).toLocaleString();
    const ridSafe = (request.rid || 'req').replace(/[^a-zA-Z0-9_-]/g,'');
    
    const forwardingInfo = this.renderForwardingInfo(request);
    
    detailsContainer.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <h2 class="text-xl font-semibold">Request Details</h2>
        <div class="flex items-center gap-2">
          <span class="chip text-xs"><span class="icon-signal"></span> ${respStatus}</span>
          <span class="chip text-xs font-mono">${request.method}</span>
        </div>
      </div>
      
      ${forwardingInfo}
      
      <div class="mt-3 grid md:grid-cols-2 gap-3">
        <!-- Meta -->
        <div class="border border-slate-200 rounded-xl p-3 bg-slate-50">
          <div class="grid grid-cols-[max-content,1fr] gap-x-4 gap-y-2 font-mono text-sm">
            <div class="text-slate-500">Time</div><div>${requestTime}</div>
            <div class="text-slate-500">IP</div><div>${request.ip}</div>
            <div class="text-slate-500">Method</div><div>${request.method}</div>
            <div class="text-slate-500">Response</div><div>${respStatus}</div>
            <div class="text-slate-500">Full URL</div><div class="break-all">${request.full_url}</div>
            <div class="text-slate-500">User-Agent</div><div class="break-all">${request.user_agent}</div>
          </div>
        </div>

        <!-- Headers -->
        <div class="border border-slate-200 rounded-xl p-3 bg-slate-50 codecard">
          <div class="flex items-center justify-between">
            <div class="text-slate-500 text-sm">Headers</div>
            <button class="text-xs text-slate-600 px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100"
                    onclick="copyToClipboard('hdr-${ridSafe}')"><span class="icon-copy"></span> Copy</button>
          </div>
          <pre id="hdr-${ridSafe}" class="whitespace-pre-wrap break-all font-mono text-sm mt-1">${prettyHeaders}</pre>
        </div>

        <!-- Query -->
        <div class="border border-slate-200 rounded-xl p-3 bg-slate-50 md:col-span-2 codecard">
          <div class="flex items-center justify-between">
            <div class="text-slate-500 text-sm">Query Params</div>
            <button class="text-xs text-slate-600 px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100"
                    onclick="copyToClipboard('qry-${ridSafe}')"><span class="icon-copy"></span> Copy</button>
          </div>
          <pre id="qry-${ridSafe}" class="whitespace-pre-wrap break-all font-mono text-sm mt-1">${prettyQuery}</pre>
        </div>

        <!-- Body -->
        <div class="border border-slate-200 rounded-xl p-3 bg-slate-50 md:col-span-2 codecard">
          <div class="flex items-center justify-between">
            <div class="text-slate-500 text-sm">Body</div>
            <button class="text-xs text-slate-600 px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100"
                    onclick="copyToClipboard('body-${ridSafe}')"><span class="icon-copy"></span> Copy</button>
          </div>
          <pre id="body-${ridSafe}" class="whitespace-pre-wrap break-all font-mono text-sm mt-1">${prettyBody}</pre>
        </div>
      </div>
    `;
  }
  
  renderForwardingInfo(request) {
    if (!request.destination && !request.proxied_status && !request.proxy_error) {
      return '';
    }
    
    let statusHtml = '';
    if (request.proxied_status) {
      statusHtml = `<div class="forwarding-status success">✓ Successfully forwarded (${request.proxied_status})</div>`;
    } else if (request.proxy_error) {
      statusHtml = `<div class="forwarding-status error">✗ Forward failed: ${request.proxy_error}</div>`;
    } else if (request.destination) {
      statusHtml = `<div class="forwarding-status pending">⏳ Forwarding to destination...</div>`;
    }
    
    return `
      <div class="mt-3 border border-slate-200 rounded-xl p-3 bg-emerald-50">
        <div class="flex items-center justify-between mb-2">
          <div class="text-slate-700 font-medium">Forwarding Information</div>
        </div>
        <div class="space-y-2">
          <div class="text-sm">
            <span class="text-slate-500">Destination:</span>
            <span class="font-mono text-slate-700">${request.destination || 'Not set'}</span>
          </div>
          ${statusHtml}
        </div>
      </div>
    `;
  }
  
  setupPagination() {
    const container = document.querySelector('.pagination-container');
    if (!container) return;
    
    this.updatePagination();
  }
  
  updatePagination() {
    const container = document.querySelector('.pagination-container');
    if (!container) return;
    
    const totalPages = Math.ceil(this.filteredRequests.length / this.pageSize);
    
    if (totalPages <= 1) {
      container.innerHTML = '';
      return;
    }
    
    let html = '<div class="pagination">';
    
    // Previous button
    html += `<button ${this.currentPage === 1 ? 'disabled' : ''} onclick="requestManager.goToPage(${this.currentPage - 1})">‹ Previous</button>`;
    
    // Page numbers
    for (let i = 1; i <= Math.min(totalPages, 5); i++) {
      const page = i;
      html += `<button class="${page === this.currentPage ? 'active' : ''}" onclick="requestManager.goToPage(${page})">${page}</button>`;
    }
    
    if (totalPages > 5) {
      html += `<span class="px-2">...</span>`;
      html += `<button class="${totalPages === this.currentPage ? 'active' : ''}" onclick="requestManager.goToPage(${totalPages})">${totalPages}</button>`;
    }
    
    // Next button
    html += `<button ${this.currentPage === totalPages ? 'disabled' : ''} onclick="requestManager.goToPage(${this.currentPage + 1})">Next ›</button>`;
    
    html += '</div>';
    container.innerHTML = html;
  }
  
  goToPage(page) {
    const totalPages = Math.ceil(this.filteredRequests.length / this.pageSize);
    if (page < 1 || page > totalPages) return;
    
    this.currentPage = page;
    this.renderRequestList();
  }
  
  updateRequestCount() {
    const countEl = document.getElementById('reqCount');
    if (countEl) {
      countEl.textContent = this.filteredRequests.length;
    }
  }
  
  setupEventListeners() {
    // Filter input
    const filterInput = document.getElementById('reqFilter');
    if (filterInput) {
      filterInput.addEventListener('input', () => {
        clearTimeout(this.filterTimeout);
        this.filterTimeout = setTimeout(() => {
          this.applyFilters();
          this.renderRequestList();
        }, 300);
      });
    }
    
    // Browser back/forward
    window.addEventListener('popstate', (event) => {
      if (event.state && event.state.rid) {
        this.selectRequest(event.state.rid);
      }
    });
  }
  
  setupSocket() {
    try {
      if (typeof io === 'undefined') return;
      
      this.socket = io();
      
      this.socket.on('connect', () => {
        console.info('Socket connected', this.socket.id);
        this.socket.emit('join', this.webhookId);
        this.setLiveConnected(true);
      });
      
      this.socket.on('disconnect', () => {
        this.setLiveConnected(false);
      });
      
      this.socket.on('request:new', (data) => {
        this.handleNewRequest(data);
      });
      
      this.socket.on('request:updated', (data) => {
        this.handleRequestUpdate(data);
      });
      
    } catch (e) {
      console.warn('Socket.IO setup failed:', e);
    }
  }
  
  handleNewRequest(request) {
    // Add to beginning of arrays
    this.allRequests.unshift(request);
    this.applyFilters();
    this.renderRequestList();
    
    // Show notification
    this.showToast('New request received', 'success');
    
    // Animate detail section
    const detailSection = document.querySelector('.request-details-container');
    if (detailSection) {
      detailSection.style.animation = 'none';
      detailSection.offsetHeight; // Trigger reflow
      detailSection.style.animation = 'request-flash 0.9s ease-out';
    }
  }
  
  handleRequestUpdate(data) {
    if (!data || !data.rid) return;
    
    // Update request in arrays
    const updateRequest = (request) => {
      if (request.rid === data.rid) {
        Object.assign(request, data);
      }
    };
    
    this.allRequests.forEach(updateRequest);
    this.filteredRequests.forEach(updateRequest);
    
    // Re-render if this request is visible
    this.renderRequestList();
    
    // Update details if this is the selected request
    if (this.selectedRid === data.rid) {
      const updatedRequest = this.allRequests.find(r => r.rid === data.rid);
      if (updatedRequest) {
        this.renderRequestDetails(updatedRequest);
      }
    }
  }
  
  setLiveConnected(connected) {
    const liveDot = document.getElementById('live_dot');
    if (liveDot) {
      liveDot.classList.toggle('bg-emerald-500', connected);
      liveDot.classList.toggle('bg-red-500', !connected);
    }
  }
  
  setLoading(loading) {
    this.isLoading = loading;
    const container = document.querySelector('.request-list-container');
    if (container) {
      container.classList.toggle('loading', loading);
    }
  }
  
  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `fixed bottom-6 right-6 px-4 py-2 rounded-lg shadow-lg animate-fadein z-50 ${
      type === 'error' ? 'bg-rose-600 text-white' :
      type === 'success' ? 'bg-emerald-600 text-white' :
      'bg-slate-900 text-white'
    }`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add('opacity-0', 'transition', 'duration-300');
    }, 2000);
    
    setTimeout(() => {
      toast.remove();
    }, 2300);
  }
}

// Global functions
function copyToClipboard(elementId) {
  const element = document.getElementById(elementId);
  if (element) {
    const text = element.textContent || element.innerText || '';
    navigator.clipboard.writeText(text).then(() => {
      requestManager.showToast('Copied to clipboard', 'success');
    }).catch(() => {
      requestManager.showToast('Failed to copy', 'error');
    });
  }
}

// CSS for request flash animation
const style = document.createElement('style');
style.textContent = `
  @keyframes request-flash {
    0% { box-shadow: 0 0 0px 0 rgba(34,197,94,0); }
    50% { box-shadow: 0 0 14px 6px rgba(34,197,94,.06); }
    100% { box-shadow: 0 0 0px 0 rgba(34,197,94,0); }
  }
`;
document.head.appendChild(style);

// Initialize when DOM is ready
let requestManager;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    requestManager = new RequestManager();
  });
} else {
  requestManager = new RequestManager();
}