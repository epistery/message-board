// Message Board Client Application
import MarkUp from './MarkUp.mjs';
import MessageBoardCommon from './message-board-common.mjs';

// Shared utility instance (for getTimeAgo, escapeHtml, generateAvatar, processImage, copyAddress)
const mb = new MessageBoardCommon();

let posts = [];
let ws = null;
let currentUser = null;
let permissions = null; // Loaded from /api/permissions
let markup = null; // Markdown renderer
let channels = []; // Available channels
let currentChannel = null; // Currently selected channel (null = general)

// Initialize
async function init() {
  // Initialize markdown renderer
  markup = new MarkUp();
  await markup.init();

  // Load channels
  await loadChannels();

  // Handle hash-based channel selection
  handleHashChange();
  window.addEventListener('hashchange', handleHashChange);

  // Load posts
  await loadPosts();

  // Connect WebSocket for real-time updates
  connectWebSocket();

  // Setup event listeners
  setupEventListeners();

  // Ensure wallet exists (auto-create if needed)
  await ensureWallet();

  // Check authentication status
  await checkAuthStatus();
}

// Ensure wallet exists, auto-creating if necessary
async function ensureWallet() {
  try {
    // Check if wallet already exists in localStorage
    const data = localStorage.getItem('epistery');
    if (data) {
      const parsed = JSON.parse(data);
      if (parsed.wallets && parsed.wallets.length > 0) {
        return;
      }
    }

    // No wallet exists - auto-create one silently using Witness
    const WitnessModule = await import('/lib/witness.js');
    const Witness = WitnessModule.default;
    window.epistery = await Witness.connect();
  } catch (error) {
    // Not critical - user can still view posts
  }
}

// Check authentication and update UI
async function checkAuthStatus() {
  // Use epistery-host's ACL endpoint (same as requestAccess widget)
  try {
    const response = await fetch('/api/acl/check-access?agent=' + encodeURIComponent('@epistery/message-board'));
    if (!response.ok) {
      throw new Error('Failed to check access');
    }

    const accessData = await response.json();

    if (accessData.address) {
      currentUser = { address: accessData.address };

      permissions = {
        address: accessData.address,
        level: accessData.level || 0,
        edit: accessData.level >= 2,  // Level 2 (editor) or higher can post
        admin: accessData.level >= 3  // Level 3 (admin) or higher
      };

      // Re-render posts now that we have currentUser (for edit/delete buttons)
      renderPosts();

      // Hide post form if user doesn't have edit access (level < 2)
      if (accessData.level < 2) {
        hidePostForm();
      }
    } else {
      // No authenticated client
      hidePostForm();
    }
  } catch (error) {
    console.error('[message-board] Access check error:', error);
    hidePostForm();
  }
}

// Load channels
async function loadChannels() {
  try {
    const response = await fetch('/agent/epistery/message-board/api/channels');
    if (!response.ok) throw new Error('Failed to load channels');

    channels = await response.json();

    // Default to "general" channel if no channel selected
    if (!currentChannel && channels.length > 0) {
      currentChannel = 'general';
    }

    renderChannels();
  } catch (error) {
    console.error('[message-board] Failed to load channels:', error);
  }
}

// Render channels in sidebar
function renderChannels() {
  const container = document.getElementById('channels-list');
  if (!container) return;

  if (channels.length === 0) {
    container.innerHTML = '<li style="padding: var(--spacer); color: var(--text-color-quiet); font-size: 0.875em;">No channels</li>';
    return;
  }

  container.innerHTML = channels.map(channel => `
    <li class="sidebar-link">
      <a href="#${channel.name === 'general' ? '' : channel.name}" class="${currentChannel === channel.name ? 'active' : ''}" onclick="return false;">
        # ${mb.escapeHtml(channel.name)}
      </a>
    </li>
  `).join('');
}

// Handle hash change for channel selection
function handleHashChange() {
  const hash = window.location.hash.slice(1); // Remove #
  const channelName = hash || 'general';

  // Only select if it's a valid channel
  const channelExists = channels.find(ch => ch.name === channelName);
  if (channelExists || channelName === 'general') {
    selectChannel(channelName);
  }
}

// Select channel
async function selectChannel(channelName) {
  currentChannel = channelName;
  renderChannels();

  // Reload posts for this channel
  await loadPosts();
}

// Load posts from API or localStorage
async function loadPosts() {
  try {
    // First, try to load from localStorage for instant display
    const cachedPosts = localStorage.getItem('message-board-posts');
    if (cachedPosts) {
      try {
        posts = JSON.parse(cachedPosts);
        renderPosts();
      } catch (e) {
        console.error('[message-board] Failed to parse cached posts:', e);
      }
    }

    // Then fetch fresh data from server (filtered by channel)
    const url = currentChannel && currentChannel !== 'general'
      ? `/agent/epistery/message-board/api/posts?channel=${encodeURIComponent(currentChannel)}`
      : '/agent/epistery/message-board/api/posts';
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to load posts');

    posts = await response.json();
    savePosts();
    renderPosts();
  } catch (error) {
    console.error('[message-board] Load error:', error);
    // If we have cached posts, don't show error
    if (!posts || posts.length === 0) {
      showError('Failed to load posts: ' + error.message);
    }
  }
}

// Save posts to localStorage (limit to most recent 50 posts to avoid quota issues)
function savePosts() {
  try {
    // Only cache the most recent 50 posts (without images to save space)
    const postsToCache = posts.slice(0, 50).map(post => ({
      id: post.id,
      text: post.text,
      author: post.author,
      authorName: post.authorName,
      timestamp: post.timestamp,
      comments: post.comments,
      // Omit image data from cache to save space
      image: null
    }));
    localStorage.setItem('message-board-posts', JSON.stringify(postsToCache));
  } catch (error) {
    if (error.name === 'QuotaExceededError') {
      console.warn('[message-board] localStorage quota exceeded, clearing cache');
      try {
        localStorage.removeItem('message-board-posts');
      } catch (e) {
        // Ignore errors when clearing
      }
    } else {
      console.error('[message-board] Failed to save posts to localStorage:', error);
    }
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
  const timeAgo = mb.getTimeAgo(date);
  const shortAddress = post.author.substring(0, 8) + '...' + post.author.substring(post.author.length - 6);
  const avatar = mb.generateAvatar(post.author, 40);

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

  // Format: "Name (0xShort...Address)" or just "(0xShort...Address)" if no name
  const authorDisplay = post.authorName
    ? `${mb.escapeHtml(post.authorName)} <span class="clickable-address" onclick="copyAddress('${post.author}')" title="Click to copy full address">(${shortAddress})</span>`
    : `<span class="clickable-address" onclick="copyAddress('${post.author}')" title="Click to copy full address">${shortAddress}</span>`;

  return `
    <div class="post" data-post-id="${post.id}" style="${pendingStyle}">
      <div class="post-header">
        <div class="post-author-section">
          <img src="${avatar}" class="avatar" alt="Avatar">
          <div>
            <div class="post-author">${authorDisplay}</div>
            <div class="post-time">${timeAgo}${pendingBadge}</div>
          </div>
        </div>
      </div>
      <div class="post-text">${markup ? markup.render(post.text) : mb.escapeHtml(post.text)}</div>
      ${imageHtml}
      <div class="post-actions">
        <button class="post-action-btn" onclick="showCommentForm(${post.id})">💬 Comment</button>
        ${currentUser && currentUser.address.toLowerCase() === post.author.toLowerCase() ? `<button class="post-action-btn" onclick="editPost(${post.id})">✏️ Edit</button>` : ''}
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
  const timeAgo = mb.getTimeAgo(date);
  const shortAddress = comment.author.substring(0, 8) + '...' + comment.author.substring(comment.author.length - 6);
  const avatar = mb.generateAvatar(comment.author, 32);

  // Format: "Name (0xShort...Address)" or just "(0xShort...Address)" if no name
  const authorDisplay = comment.authorName
    ? `${mb.escapeHtml(comment.authorName)} <span class="clickable-address" onclick="copyAddress('${comment.author}')" title="Click to copy full address">(${shortAddress})</span>`
    : `<span class="clickable-address" onclick="copyAddress('${comment.author}')" title="Click to copy full address">${shortAddress}</span>`;

  return `
    <div class="comment">
      <div class="comment-with-avatar">
        <img src="${avatar}" class="avatar avatar-small" alt="Avatar">
        <div class="comment-content">
          <div class="comment-header">
            <span class="comment-author">${authorDisplay}</span>
            <span class="comment-time">${timeAgo}</span>
          </div>
          <div class="comment-text">${markup ? markup.render(comment.text) : mb.escapeHtml(comment.text)}</div>
        </div>
      </div>
    </div>
  `;
}

// Copy address to clipboard
window.copyAddress = (address) => mb.copyAddress(address);

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
    const headers = { 'Content-Type': 'application/json' };

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

// Edit post - show edit form
window.editPost = function(postId) {
  const post = posts.find(p => p.id === postId);
  if (!post) return;

  const postElement = document.querySelector(`[data-post-id="${postId}"]`);
  if (!postElement) return;

  const postTextDiv = postElement.querySelector('.post-text');
  const postActionsDiv = postElement.querySelector('.post-actions');

  // Store original content
  postElement.dataset.originalText = post.text;

  // Replace post text with textarea
  postTextDiv.innerHTML = `
    <textarea id="edit-textarea-${postId}" class="edit-textarea" rows="4">${mb.escapeHtml(post.text)}</textarea>
    <div class="markdown-hint" style="margin-top: 6px;">
      Markdown: **bold** *italic* [link](url) \`code\` - list
    </div>
  `;

  // Replace actions with save/cancel
  postActionsDiv.innerHTML = `
    <button class="post-action-btn" onclick="saveEdit(${postId})">Save</button>
    <button class="post-action-btn" onclick="cancelEdit(${postId})">Cancel</button>
  `;

  // Focus the textarea
  const textarea = document.getElementById(`edit-textarea-${postId}`);
  if (textarea) {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }
};

// Save edited post
window.saveEdit = async function(postId) {
  const textarea = document.getElementById(`edit-textarea-${postId}`);
  if (!textarea) return;

  const text = textarea.value.trim();
  if (!text) {
    showError('Post text cannot be empty');
    return;
  }

  try {
    const headers = { 'Content-Type': 'application/json' };

    const response = await fetch(`/agent/epistery/message-board/api/posts/${postId}`, {
      method: 'PATCH',
      headers,
      credentials: 'include',
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update post');
      } else {
        throw new Error(`Failed to update post (${response.status}).`);
      }
    }

    // Update local post data
    const post = posts.find(p => p.id === postId);
    if (post) {
      post.text = text;
      post.editedAt = Date.now();
    }
    savePosts();
    renderPosts();
  } catch (error) {
    console.error('[message-board] Edit error:', error);
    showError(error.message);
  }
};

// Cancel edit
window.cancelEdit = function(postId) {
  // Just re-render posts to restore original state
  renderPosts();
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

    // Show loading state
    imagePreview.style.display = 'block';
    imagePreview.src = 'data:image/svg+xml;base64,' + btoa(`
      <svg width="200" height="100" xmlns="http://www.w3.org/2000/svg">
        <rect width="200" height="100" fill="#f0f0f0"/>
        <text x="100" y="50" text-anchor="middle" font-family="Arial" font-size="14" fill="#666">
          Processing image...
        </text>
      </svg>
    `);

    try {
      // Validate and process image
      const processedImage = await mb.processImage(file);
      imagePreview.src = processedImage;
      imagePreview.style.display = 'block';
    } catch (error) {
      console.error('[message-board] Image processing error:', error);
      showError(error.message);
      imageInput.value = ''; // Clear the input
      imagePreview.style.display = 'none';
    }
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
      image: imagePreview.style.display !== 'none' ? imagePreview.src : null,
      channel: currentChannel && currentChannel !== 'general' ? currentChannel : null
    };

    const headers = { 'Content-Type': 'application/json' };

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

    // Get the confirmed post from server response
    const confirmedPost = await response.json();

    // Add confirmed post to posts array at the beginning
    posts.unshift(confirmedPost);
    savePosts();
    renderPosts();

    // Clear form
    postText.value = '';
    imagePreview.style.display = 'none';
    imagePreview.src = '';
    document.getElementById('image-input').value = '';
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

  ws.onopen = () => {};

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    handleWebSocketMessage(message);
  };

  ws.onclose = () => {
    setTimeout(connectWebSocket, 5000);
  };

  ws.onerror = (error) => {
    console.error('[message-board] WebSocket error:', error);
  };
}

// Handle WebSocket messages
function handleWebSocketMessage(message) {
  switch (message.type) {
    case 'new-post':
      // Check if this post already exists (avoid duplicates)
      if (!posts.find(p => p.id === message.post.id)) {
        posts.unshift(message.post);
      }
      savePosts();
      renderPosts();
      break;

    case 'new-comment':
      const post = posts.find(p => p.id === message.postId);
      if (post) {
        // Check if comment already exists (avoid duplicates)
        if (!post.comments.find(c => c.id === message.comment.id)) {
          post.comments.push(message.comment);
        }
        savePosts();
        renderPosts();
      }
      break;

    case 'delete-post':
      posts = posts.filter(p => p.id !== message.postId);
      savePosts();
      renderPosts();
      break;

    case 'edit-post':
      const editedPost = posts.find(p => p.id === message.post.id);
      if (editedPost) {
        editedPost.text = message.post.text;
        editedPost.editedAt = message.post.editedAt;
        savePosts();
        renderPosts();
      }
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

// Show request access dialog
function showRequestAccessDialog(address, reason) {
  const container = document.getElementById('error-container');
  const dialog = document.createElement('div');
  dialog.className = 'error-message';
  dialog.style.cssText = 'padding: 20px; box-sizing: border-box;';
  dialog.innerHTML = `
    <div style="margin-bottom: 12px;">
      <strong>⚠️ Access Required</strong>
    </div>
    <p style="margin: 10px 0;">${mb.escapeHtml(reason)}</p>
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
      await requestAccess(address, 'Requesting access to post on message board', '');
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

// UI State Management
function hidePostForm() {
  const container = document.getElementById('create-post');
  if (container) {
    container.style.display = 'none';
  }
}

async function requestAccess(address, customMessage, customName) {
  const listName = 'epistery::editor';
  const agentName = '@epistery/message-board';

  const response = await fetch('/api/acl/request-access', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      address,
      listName,
      agentName,
      message: customMessage || 'Requesting access to post on message board',
      name: customName || ''
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
