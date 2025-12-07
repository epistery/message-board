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

  // Connect WebSocket for real-time updates
  connectWebSocket();

  // Setup event listeners
  setupEventListeners();

  // Check authentication status
  checkAuthStatus();

  console.log('[message-board] Ready');
}

// Check authentication and update UI
function checkAuthStatus() {
  // Check for delegation token in cookies
  const cookies = document.cookie.split(';');
  let token = null;

  for (let cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === 'epistery_delegation') {
      try {
        token = JSON.parse(decodeURIComponent(value));
        break;
      } catch (e) {
        console.error('[message-board] Failed to parse delegation token:', e);
      }
    }
  }

  const statusEl = document.getElementById('user-status');

  if (token && token.delegation) {
    const address = token.delegation.subject;

    statusEl.className = 'user-status authenticated';
    statusEl.innerHTML = `
      ✓ Authenticated as <strong class="clickable-address" onclick="copyAddress('${address}')" style="cursor: pointer; text-decoration: underline;" title="Click to copy">${address}</strong>
      <span style="margin-left: 10px; font-size: 12px; opacity: 0.8;">You can post and comment</span>
    `;

    currentUser = { address };
  } else {
    statusEl.className = 'user-status guest';
    const currentDomain = window.location.hostname;
    const returnUrl = encodeURIComponent(window.location.href);
    statusEl.innerHTML = `
      👁️ Viewing as guest - <a href="/.well-known/epistery/delegate?domain=${currentDomain}&return=${returnUrl}" style="color: inherit; text-decoration: underline;">Sign in</a> to post
    `;
  }
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

  return `
    <div class="post" data-post-id="${post.id}">
      <div class="post-header">
        <div>
          <div class="post-author">${post.authorName || shortAddress}</div>
          ${post.authorName ? `<div class="post-address clickable-address" onclick="copyAddress('${post.author}')" title="Click to copy full address">${shortAddress}</div>` : `<div class="post-address clickable-address" onclick="copyAddress('${post.author}')" title="Click to copy full address">${post.author}</div>`}
        </div>
        <div class="post-time">${timeAgo}</div>
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
    const response = await fetch(`/agent/epistery/message-board/api/posts/${postId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const response = await fetch(`/agent/epistery/message-board/api/posts/${postId}`, {
      method: 'DELETE',
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

    const response = await fetch('/agent/epistery/message-board/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to post');
      } else {
        const text = await response.text();
        console.error('[message-board] Server response:', text);
        throw new Error(`Failed to post (${response.status}). ${text.substring(0, 100)}`);
      }
    }

    // Clear form
    postText.value = '';
    imagePreview.style.display = 'none';
    imagePreview.src = '';
    document.getElementById('image-input').value = '';

    // Reload posts
    await loadPosts();
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

// Start app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
