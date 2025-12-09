// Message Board Client Application
let posts = [];
let ws = null;
let currentUser = null;

// Load navigation menu dynamically
async function loadNavMenu() {
  try {
    const response = await fetch('/api/nav-menu');
    const html = await response.text();
    const nav = document.querySelector('nav.container');
    const existingMenu = document.getElementById('nav-menu');
    if (existingMenu) {
      existingMenu.remove();
    }
    nav.insertAdjacentHTML('beforeend', html);
  } catch (error) {
    console.error('Failed to load navigation menu:', error);
  }
}

// Initialize
async function init() {
  console.log('[message-board] Initializing...');

  // Load navigation menu
  await loadNavMenu();

  // Load posts
  await loadPosts();

  // Connect WebSocket for real-time updates (disabled - not critical for functionality)
  // connectWebSocket();

  // Setup event listeners
  setupEventListeners();

  // Ensure wallet exists (auto-create if needed)
  await ensureWallet();

  // Check authentication status
  checkAuthStatus();

  console.log('[message-board] Ready');
}

// Ensure wallet exists, auto-creating if necessary
async function ensureWallet() {
  try {
    // Check if wallet already exists in localStorage
    const data = localStorage.getItem('epistery');
    if (data) {
      const parsed = JSON.parse(data);
      if (parsed.wallets && parsed.wallets.length > 0) {
        console.log('[message-board] Wallet already exists');
        return;
      }
    }

    // No wallet exists - auto-create one silently using Witness
    console.log('[message-board] No wallet found, creating one...');
    const WitnessModule = await import('/lib/witness.js');
    const Witness = WitnessModule.default;
    await Witness.connect();
    console.log('[message-board] Wallet created successfully');
  } catch (error) {
    console.log('[message-board] Could not auto-create wallet:', error.message);
    // Not critical - user can still view posts
  }
}

// Check authentication and update UI
async function checkAuthStatus() {
  const statusEl = document.getElementById('user-status');

  // Try to get wallet address from localStorage (same-domain as home page)
  try {
    console.log('[message-board] Checking localStorage for epistery wallet...');
    console.log('[message-board] Origin:', window.location.origin);
    console.log('[message-board] localStorage length:', localStorage.length);

    const data = localStorage.getItem('epistery');
    console.log('[message-board] localStorage.epistery exists:', !!data);

    if (data) {
      const parsed = JSON.parse(data);
      console.log('[message-board] Parsed data keys:', Object.keys(parsed));
      console.log('[message-board] Wallets count:', parsed.wallets ? parsed.wallets.length : 0);
      console.log('[message-board] Default wallet ID:', parsed.defaultWalletId);

      // Get the default wallet from the wallets array
      let wallet = null;
      if (parsed.wallets && parsed.wallets.length > 0) {
        // Find the default wallet
        wallet = parsed.wallets.find(w => w.id === parsed.defaultWalletId);
        console.log('[message-board] Found default wallet:', !!wallet);

        // Fallback to first wallet if no default
        if (!wallet) {
          wallet = parsed.wallets[0];
          console.log('[message-board] Using first wallet as fallback');
        }

        // Extract actual wallet object from wrapper
        if (wallet && wallet.wallet) {
          console.log('[message-board] Wallet wrapper found, extracting...');
          wallet = wallet.wallet;
        }
      }

      console.log('[message-board] Final wallet:', wallet);

      if (wallet && wallet.address) {
        const address = wallet.rivetAddress || wallet.address;
        console.log('[message-board] Authenticated as:', address);

        statusEl.className = 'user-status authenticated';
        statusEl.innerHTML = `
          ✓ Authenticated as <strong class="clickable-address" onclick="copyAddress('${address}')" style="cursor: pointer; text-decoration: underline;" title="Click to copy">${address}</strong>
        `;

        currentUser = { address };

        // Check if user has posting permission
        await checkPostingPermission(address);
        return;
      } else {
        console.log('[message-board] No valid wallet address found in structure');
      }
    }
  } catch (e) {
    console.error('[message-board] Error checking localStorage:', e);
  }

  // No wallet in localStorage - show guest status
  statusEl.className = 'user-status guest';
  statusEl.innerHTML = `
    👁️ Viewing as guest
    <div style="margin-top: 8px; font-size: 12px; opacity: 0.8;">
      <a href="/status" style="color: inherit; text-decoration: underline;">View wallet & admin settings</a>
    </div>
  `;
}

// Load posts from API
async function loadPosts() {
  try {
    const response = await fetch('/agent/epistery/message-board/api/posts');
    if (!response.ok) throw new Error('Failed to load posts');

    posts = await response.json();
    renderPosts();
  } catch (error) {
    console.error('[message-board] Load error:', error);
    showError('Failed to load posts: ' + error.message);
  }
}

// Render posts
function renderPosts() {
  const container = document.getElementById('posts-container');

  if (posts.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">💬</div>
        <p>No posts yet. Be the first to post!</p>
      </div>
    `;
    return;
  }

  container.innerHTML = posts.map(post => renderPost(post)).join('');
}

// Render single post
function renderPost(post) {
  const date = new Date(post.timestamp);
  const timeAgo = getTimeAgo(date);
  const shortAddress = post.author.substring(0, 8) + '...' + post.author.substring(post.author.length - 6);

  const commentsHtml = post.comments && post.comments.length > 0
    ? `
      <div class="comments">
        ${post.comments.map(comment => renderComment(comment)).join('')}
      </div>
    `
    : '';

  const imageHtml = post.image
    ? `<img src="${post.image}" class="post-image" alt="Post image">`
    : '';

  const pendingStyle = post.pending ? 'opacity: 0.7;' : '';
  const pendingBadge = post.pending ? '<span style="color: #ffa500; font-size: 12px; margin-left: 8px;">⏳ Pending confirmation...</span>' : '';

  return `
    <div class="post" data-post-id="${post.id}" style="${pendingStyle}">
      <div class="post-header">
        <div>
          <div class="post-author">${post.authorName || shortAddress}</div>
          ${post.authorName ? `<div class="post-address clickable-address" onclick="copyAddress('${post.author}')" title="Click to copy full address">${shortAddress}</div>` : `<div class="post-address clickable-address" onclick="copyAddress('${post.author}')" title="Click to copy full address">${post.author}</div>`}
        </div>
        <div class="post-time">${timeAgo}${pendingBadge}</div>
      </div>
      <div class="post-text">${escapeHtml(post.text)}</div>
      ${imageHtml}
      <div class="post-actions">
        <button class="post-action-btn" onclick="showCommentForm(${post.id})">💬 Comment</button>
        ${currentUser ? `<button class="post-action-btn delete" onclick="deletePost(${post.id})">🗑️ Delete</button>` : ''}
      </div>
      ${commentsHtml}
      <div class="comment-form" id="comment-form-${post.id}" style="display: none;">
        <input type="text" id="comment-input-${post.id}" placeholder="Write a comment...">
        <button onclick="addComment(${post.id})">Post</button>
      </div>
    </div>
  `;
}

// Render comment
function renderComment(comment) {
  const date = new Date(comment.timestamp);
  const timeAgo = getTimeAgo(date);
  const shortAddress = comment.author.substring(0, 8) + '...' + comment.author.substring(comment.author.length - 6);

  return `
    <div class="comment">
      <div class="comment-header">
        <span class="comment-author">${comment.authorName || shortAddress}</span>
        <span class="comment-time">${timeAgo}</span>
      </div>
      <div class="comment-text">${escapeHtml(comment.text)}</div>
    </div>
  `;
}

// Copy address to clipboard
window.copyAddress = async function(address) {
  try {
    await navigator.clipboard.writeText(address);

    // Show brief confirmation
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #155724;
      color: white;
      padding: 12px 20px;
      border-radius: 6px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      z-index: 10000;
      animation: slideIn 0.3s ease;
    `;
    notification.textContent = 'Address copied to clipboard!';
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.remove();
    }, 2000);
  } catch (error) {
    console.error('[message-board] Failed to copy address:', error);
    alert('Failed to copy address');
  }
};

// Show comment form
window.showCommentForm = function(postId) {
  const form = document.getElementById(`comment-form-${postId}`);
  if (form) {
    form.style.display = form.style.display === 'none' ? 'flex' : 'none';
  }
};

// Add comment
window.addComment = async function(postId) {
  const input = document.getElementById(`comment-input-${postId}`);
  const text = input.value.trim();

  if (!text) return;

  try {
    // Add wallet address header for same-domain authentication
    const headers = { 'Content-Type': 'application/json' };
    if (currentUser && currentUser.address) {
      headers['X-Wallet-Address'] = currentUser.address;
    }

    const response = await fetch(`/agent/epistery/message-board/api/posts/${postId}/comments`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to post comment');
      } else {
        throw new Error(`Failed to post comment (${response.status}). Please ensure you are authenticated.`);
      }
    }

    input.value = '';
    await loadPosts(); // Reload to show new comment
  } catch (error) {
    console.error('[message-board] Comment error:', error);
    showError(error.message);
  }
};

// Delete post
window.deletePost = async function(postId) {
  if (!confirm('Delete this post?')) return;

  try {
    // Add wallet address header for same-domain authentication
    const headers = {};
    if (currentUser && currentUser.address) {
      headers['X-Wallet-Address'] = currentUser.address;
    }

    const response = await fetch(`/agent/epistery/message-board/api/posts/${postId}`, {
      method: 'DELETE',
      headers,
      credentials: 'include'
    });

    if (!response.ok) {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete post');
      } else {
        throw new Error(`Failed to delete post (${response.status}). Please ensure you are authenticated.`);
      }
    }

    await loadPosts();
  } catch (error) {
    console.error('[message-board] Delete error:', error);
    showError(error.message);
  }
};

// Setup event listeners
function setupEventListeners() {
  const postButton = document.getElementById('post-button');
  const postText = document.getElementById('post-text');
  const imageInput = document.getElementById('image-input');
  const imagePreview = document.getElementById('image-preview');

  postButton.addEventListener('click', createPost);

  postText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      createPost();
    }
  });

  imageInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Show preview
    const reader = new FileReader();
    reader.onload = (e) => {
      imagePreview.src = e.target.result;
      imagePreview.style.display = 'block';
    };
    reader.readAsDataURL(file);
  });
}

// Create new post
async function createPost() {
  const postText = document.getElementById('post-text');
  const imagePreview = document.getElementById('image-preview');
  const postButton = document.getElementById('post-button');

  const text = postText.value.trim();
  if (!text) return;

  postButton.disabled = true;
  postButton.textContent = 'Posting...';

  try {
    const body = {
      text,
      image: imagePreview.style.display !== 'none' ? imagePreview.src : null
    };

    // Add wallet address header for same-domain authentication
    const headers = { 'Content-Type': 'application/json' };
    if (currentUser && currentUser.address) {
      headers['X-Wallet-Address'] = currentUser.address;
    }

    const response = await fetch('/agent/epistery/message-board/api/posts', {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const error = await response.json();

        // Handle 403 - show request access option
        if (response.status === 403 && currentUser && currentUser.address) {
          showRequestAccessDialog(currentUser.address, error.error || 'You do not have permission to post');
          return;
        }

        throw new Error(error.error || 'Failed to post');
      } else {
        const text = await response.text();
        console.error('[message-board] Server response:', text);
        throw new Error(`Failed to post (${response.status}). ${text.substring(0, 100)}`);
      }
    }

    // Create optimistic post to show immediately
    const optimisticPost = {
      id: Date.now(), // temporary ID
      text,
      image: imagePreview.style.display !== 'none' ? imagePreview.src : null,
      author: currentUser.address,
      authorName: currentUser.name,
      timestamp: new Date().toISOString(),
      comments: [],
      pending: true // mark as pending confirmation
    };

    // Add to posts array at the beginning
    posts.unshift(optimisticPost);
    renderPosts();

    // Clear form
    postText.value = '';
    imagePreview.style.display = 'none';
    imagePreview.src = '';
    document.getElementById('image-input').value = '';

    // Reload posts to get the confirmed version
    setTimeout(() => loadPosts(), 2000);
  } catch (error) {
    console.error('[message-board] Post error:', error);
    showError(error.message);
  } finally {
    postButton.disabled = false;
    postButton.textContent = 'Post';
  }
}

// Connect WebSocket for real-time updates
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/agent/epistery/message-board/ws`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[message-board] WebSocket connected');
  };

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    handleWebSocketMessage(message);
  };

  ws.onclose = () => {
    console.log('[message-board] WebSocket disconnected, reconnecting...');
    setTimeout(connectWebSocket, 5000);
  };

  ws.onerror = (error) => {
    console.error('[message-board] WebSocket error:', error);
  };
}

// Handle WebSocket messages
function handleWebSocketMessage(message) {
  console.log('[message-board] WebSocket message:', message);

  switch (message.type) {
    case 'new-post':
      posts.unshift(message.post);
      renderPosts();
      break;

    case 'new-comment':
      const post = posts.find(p => p.id === message.postId);
      if (post) {
        post.comments.push(message.comment);
        renderPosts();
      }
      break;

    case 'delete-post':
      posts = posts.filter(p => p.id !== message.postId);
      renderPosts();
      break;
  }
}

// Show error message
function showError(message) {
  const container = document.getElementById('error-container');
  const errorEl = document.createElement('div');
  errorEl.className = 'error-message';
  errorEl.textContent = message;
  container.appendChild(errorEl);

  setTimeout(() => {
    errorEl.remove();
  }, 5000);
}

// Utility: Get time ago string
function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);

  const intervals = {
    year: 31536000,
    month: 2592000,
    week: 604800,
    day: 86400,
    hour: 3600,
    minute: 60
  };

  for (const [unit, secondsInUnit] of Object.entries(intervals)) {
    const interval = Math.floor(seconds / secondsInUnit);
    if (interval >= 1) {
      return `${interval} ${unit}${interval === 1 ? '' : 's'} ago`;
    }
  }

  return 'just now';
}

// Utility: Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Show request access dialog
function showRequestAccessDialog(address, reason) {
  const container = document.getElementById('error-container');
  const dialog = document.createElement('div');
  dialog.className = 'error-message';
  dialog.style.cssText = 'padding: 20px; max-width: 500px;';
  dialog.innerHTML = `
    <div style="margin-bottom: 12px;">
      <strong>⚠️ Access Required</strong>
    </div>
    <p style="margin: 10px 0;">${escapeHtml(reason)}</p>
    <p style="margin: 10px 0; font-size: 14px; opacity: 0.9;">
      Your address: <code>${address.substring(0, 8)}...${address.substring(address.length - 6)}</code>
    </p>
    <div style="margin-top: 15px; display: flex; gap: 10px;">
      <button id="request-access-btn" style="padding: 8px 16px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
        Request Access
      </button>
      <button id="cancel-request-btn" style="padding: 8px 16px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;">
        Cancel
      </button>
    </div>
  `;
  container.appendChild(dialog);

  document.getElementById('request-access-btn').addEventListener('click', async () => {
    try {
      await requestAccess(address);
      dialog.innerHTML = `
        <div style="margin-bottom: 12px;">
          <strong>✓ Request Submitted</strong>
        </div>
        <p style="margin: 10px 0;">
          Your access request has been submitted to the domain administrators.
          You will be notified when your request is approved.
        </p>
      `;
      setTimeout(() => dialog.remove(), 5000);
    } catch (error) {
      showError('Failed to submit access request: ' + error.message);
      dialog.remove();
    }
  });

  document.getElementById('cancel-request-btn').addEventListener('click', () => {
    dialog.remove();
  });
}

// Request access from white-list agent
// Check if user has posting permission
async function checkPostingPermission(address) {
  try {
    // Make a test request to check permissions without actually posting
    const response = await fetch('/agent/epistery/message-board/api/check-permission', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wallet-Address': address
      },
      credentials: 'include'
    });

    if (response.ok) {
      const data = await response.json();
      if (!data.canPost) {
        // Wait for DOM to be ready
        const waitForElement = setInterval(() => {
          const container = document.getElementById('create-post');
          if (container) {
            clearInterval(waitForElement);
            showWelcomeBox(address);
          }
        }, 100);
      }
    }
  } catch (error) {
    console.log('[message-board] Permission check failed:', error);
  }
}

// Show welcome box for users without posting permission
function showWelcomeBox(address) {
  const container = document.getElementById('create-post');
  if (!container) {
    console.error('[message-board] create-post element not found');
    return;
  }
  container.innerHTML = `
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px; color: white; text-align: center;">
      <h2 style="margin: 0 0 15px 0; font-size: 24px;">Welcome to the Message Board! 👋</h2>
      <p style="margin: 0 0 20px 0; font-size: 16px; opacity: 0.95;">
        You're authenticated, but you'll need access to post messages.
      </p>
      <button
        onclick="showRequestAccessForm()"
        style="background: white; color: #667eea; border: none; padding: 12px 30px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.1);"
      >
        Request Access to Post
      </button>
    </div>
  `;
}

// Show request access form
window.showRequestAccessForm = function() {
  const container = document.getElementById('create-post');
  container.innerHTML = `
    <div style="background: #f8f9fa; padding: 25px; border-radius: 12px; border: 2px solid #667eea;">
      <h3 style="margin: 0 0 15px 0; color: #333;">Request Posting Access</h3>
      <p style="margin: 0 0 15px 0; color: #666; font-size: 14px;">
        Tell the administrators why you'd like to post on this message board.
      </p>
      <textarea
        id="access-request-message"
        placeholder="e.g., I'd like to contribute to discussions about..."
        style="width: 100%; min-height: 100px; padding: 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; resize: vertical;"
      ></textarea>
      <div style="display: flex; gap: 10px; margin-top: 15px;">
        <button
          onclick="submitAccessRequest()"
          style="flex: 1; background: #667eea; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;"
        >
          Submit Request
        </button>
        <button
          onclick="showWelcomeBox('${currentUser.address}')"
          style="flex: 0 0 auto; background: #6c757d; color: white; border: none; padding: 12px 20px; border-radius: 8px; font-size: 16px; cursor: pointer;"
        >
          Cancel
        </button>
      </div>
    </div>
  `;
  document.getElementById('access-request-message').focus();
};

// Submit access request
window.submitAccessRequest = async function() {
  const messageInput = document.getElementById('access-request-message');
  const message = messageInput.value.trim();

  if (!message) {
    alert('Please provide a message explaining why you need access');
    return;
  }

  try {
    await requestAccess(currentUser.address, message);

    const container = document.getElementById('create-post');
    container.innerHTML = `
      <div style="background: #d4edda; padding: 25px; border-radius: 12px; border: 2px solid #28a745; text-align: center;">
        <h3 style="margin: 0 0 10px 0; color: #155724;">✓ Request Submitted!</h3>
        <p style="margin: 0; color: #155724; font-size: 14px;">
          Your access request has been sent to the administrators. You'll be able to post once they approve your request.
        </p>
      </div>
    `;
  } catch (error) {
    alert('Failed to submit request: ' + error.message);
  }
};

async function requestAccess(address, customMessage) {
  const hostname = window.location.hostname;
  const listName = `${hostname}::admin`;

  const response = await fetch('/agent/epistery/white-list/request-access', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      address,
      listName,
      agentName: 'message-board',
      message: customMessage || 'Requesting access to post on message board'
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Request failed');
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || 'Request failed');
  }

  return result;
}

// Start app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
