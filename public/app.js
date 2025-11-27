// Cache for posts with service worker integration
let postsCache = [];
let ws = null;
let currentUser = null;

// Initialize app
async function init() {
  console.log('[init] Starting app initialization');
  console.log('[init] episteryWhiteList loaded:', !!window.episteryWhiteList);
  console.log('[init] episteryAccess:', window.episteryAccess);

  // Register service worker
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js');
      console.log('Service Worker registered');
    } catch (error) {
      console.error('Service Worker registration failed:', error);
    }
  }

  // Setup epistery event listeners
  setupEpisteryListeners();

  // Load initial posts
  await loadPosts();

  // Connect WebSocket
  connectWebSocket();

  // Setup event listeners
  setupEventListeners();

  // Periodically update status in case token state changes
  setInterval(() => {
    updateUserStatus();
  }, 2000);

  console.log('[init] Initialization complete');
}

// Setup epistery white-list event listeners
function setupEpisteryListeners() {
  // Check if already authenticated (from white-list client.js)
  if (window.episteryAccess) {
    currentUser = window.episteryAccess;
    updateUserStatus();
    console.log('Initial access state:', window.episteryAccess);
  }

  window.addEventListener('epistery:access-granted', (e) => {
    currentUser = e.detail;
    updateUserStatus();
    console.log('Access granted:', e.detail);
  });

  window.addEventListener('epistery:access-denied', (e) => {
    currentUser = null;
    updateUserStatus();
    console.log('Access denied:', e.detail);
  });

  window.addEventListener('epistery:passive-mode', (e) => {
    currentUser = null;
    updateUserStatus();
    console.log('Passive mode:', e.detail);
  });
}

// Update user status display
function updateUserStatus(message = '') {
  const statusEl = document.getElementById('user-status');
  statusEl.innerHTML = ''; // Clear previous content

  // Get current token to verify we have it
  const token = window.episteryWhiteList?.getDelegationToken();

  if (currentUser && currentUser.address) {
    // Show full address for authenticated users
    const addressSpan = document.createElement('span');
    addressSpan.className = 'user-address';
    addressSpan.textContent = `Signed in as ${currentUser.address}`;
    statusEl.appendChild(addressSpan);

    console.log('[status] Current user:', currentUser.address);
    console.log('[status] Has delegation token:', !!token);
  } else if (token && token.delegation) {
    // Have token but no user object - extract from token
    const addressSpan = document.createElement('span');
    addressSpan.className = 'user-address';
    addressSpan.textContent = `Signed in as ${token.delegation.subject}`;
    statusEl.appendChild(addressSpan);

    console.log('[status] Signed in via token:', token.delegation.subject);
  } else {
    statusEl.textContent = message || 'Not signed in';
    console.log('[status] No authentication');
  }

  // Add sign-in button if not authenticated
  if (!currentUser && !token) {
    const signInBtn = document.createElement('button');
    signInBtn.textContent = 'Sign In';
    signInBtn.className = 'sign-in-button';
    signInBtn.onclick = () => {
      console.log('[sign-in] Button clicked');
      console.log('[sign-in] episteryWhiteList available:', !!window.episteryWhiteList);

      if (window.episteryWhiteList) {
        console.log('[sign-in] Calling requestDelegation...');
        try {
          window.episteryWhiteList.requestDelegation();
        } catch (error) {
          console.error('[sign-in] Error calling requestDelegation:', error);
          alert('Failed to initiate sign-in: ' + error.message);
        }
      } else {
        console.error('[sign-in] episteryWhiteList not available');
        alert('Authentication system not loaded. Please refresh the page.');
      }
    };
    statusEl.appendChild(signInBtn);
  }
}

// Shorten Ethereum address for display
function shortenAddress(address) {
  if (!address) return 'anonymous';
  if (address.startsWith('anonymous')) return 'anonymous';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Load posts from server
async function loadPosts() {
  try {
    const response = await fetch('/api/posts');
    postsCache = await response.json();
    renderPosts();

    // Update service worker cache
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'UPDATE_CACHE',
        posts: postsCache
      });
    }
  } catch (error) {
    console.error('Failed to load posts:', error);
    // Try to load from service worker cache
    loadFromCache();
  }
}

// Load posts from service worker cache
async function loadFromCache() {
  if (!navigator.serviceWorker.controller) return;

  navigator.serviceWorker.controller.postMessage({ type: 'GET_CACHE' });
}

// Listen for cache updates from service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data.type === 'CACHED_POSTS') {
      postsCache = event.data.posts || [];
      renderPosts();
    }
  });
}

// Connect to WebSocket
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    console.log('WebSocket connected');
  };

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    handleWebSocketMessage(message);
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected, reconnecting...');
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
}

// Handle WebSocket messages
function handleWebSocketMessage(message) {
  if (message.type === 'new-post') {
    postsCache.unshift(message.post);
    renderPosts();
    updateServiceWorkerCache();
  } else if (message.type === 'new-comment') {
    const post = postsCache.find(p => p.id === message.postId);
    if (post) {
      post.comments.push(message.comment);
      renderPosts();
      updateServiceWorkerCache();
    }
  }
}

// Update service worker cache
function updateServiceWorkerCache() {
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'UPDATE_CACHE',
      posts: postsCache
    });
  }
}

// Setup event listeners
function setupEventListeners() {
  const postButton = document.getElementById('post-button');
  const postText = document.getElementById('post-text');
  const imageInput = document.getElementById('image-input');
  const imagePreview = document.getElementById('image-preview');

  postButton.addEventListener('click', createPost);

  postText.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      createPost();
    }
  });

  imageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        imagePreview.src = e.target.result;
        imagePreview.style.display = 'block';
      };
      reader.readAsDataURL(file);
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

  const image = imagePreview.style.display === 'block' ? imagePreview.src : null;

  postButton.disabled = true;

  try {
    // Get delegation token from white-list agent
    const token = window.episteryWhiteList?.getDelegationToken();
    const headers = { 'Content-Type': 'application/json' };

    if (token) {
      headers['X-Epistery-Delegation'] = JSON.stringify(token);
      console.log('[post] Sending delegation token:', token.delegation?.subject);
    } else {
      console.warn('[post] No delegation token available');
    }

    const response = await fetch('/api/posts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, image })
    });

    if (response.ok) {
      postText.value = '';
      imagePreview.style.display = 'none';
      document.getElementById('image-input').value = '';
    } else {
      const error = await response.json();
      console.error('[post] Server error:', error);
      alert(`Failed to create post: ${error.message || error.error || 'Unknown error'}`);
    }
  } catch (error) {
    console.error('Failed to create post:', error);
    alert(`Failed to create post: ${error.message}`);
  } finally {
    postButton.disabled = false;
  }
}

// Create comment
async function createComment(postId, text) {
  try {
    // Get delegation token from white-list agent
    const token = window.episteryWhiteList?.getDelegationToken();
    const headers = { 'Content-Type': 'application/json' };

    if (token) {
      headers['X-Epistery-Delegation'] = JSON.stringify(token);
    }

    const response = await fetch(`/api/posts/${postId}/comments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      alert('Failed to add comment');
    }
  } catch (error) {
    console.error('Failed to add comment:', error);
    alert('Failed to add comment');
  }
}

// Render all posts
function renderPosts() {
  const container = document.getElementById('posts-container');
  container.innerHTML = '';

  postsCache.forEach(post => {
    const postEl = createPostElement(post);
    container.appendChild(postEl);
  });
}

// Create post element
function createPostElement(post) {
  const div = document.createElement('div');
  div.className = 'post';

  const header = document.createElement('div');
  header.className = 'post-header';
  header.innerHTML = `
    <span>Posted by ${post.author}</span>
    <span class="timestamp">${formatTime(post.timestamp)}</span>
  `;

  const text = document.createElement('div');
  text.className = 'post-text';
  text.textContent = post.text;

  div.appendChild(header);
  div.appendChild(text);

  if (post.image) {
    const img = document.createElement('img');
    img.className = 'post-image';
    img.src = post.image;
    div.appendChild(img);
  }

  // Comments section
  const commentsSection = document.createElement('div');
  commentsSection.className = 'comments-section';

  post.comments.forEach(comment => {
    const commentEl = createCommentElement(comment);
    commentsSection.appendChild(commentEl);
  });

  // Comment form
  const commentForm = document.createElement('div');
  commentForm.className = 'comment-form';
  commentForm.innerHTML = `
    <input type="text" class="comment-input" placeholder="Add a comment...">
    <button class="comment-button">Comment</button>
  `;

  const commentInput = commentForm.querySelector('.comment-input');
  const commentButton = commentForm.querySelector('.comment-button');

  const submitComment = async () => {
    const text = commentInput.value.trim();
    if (!text) return;

    commentButton.disabled = true;
    await createComment(post.id, text);
    commentInput.value = '';
    commentButton.disabled = false;
  };

  commentButton.addEventListener('click', submitComment);
  commentInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      submitComment();
    }
  });

  commentsSection.appendChild(commentForm);
  div.appendChild(commentsSection);

  return div;
}

// Create comment element
function createCommentElement(comment) {
  const div = document.createElement('div');
  div.className = 'comment';

  div.innerHTML = `
    <div class="comment-header">
      ${comment.author} • ${formatTime(comment.timestamp)}
    </div>
    <div class="comment-text">${comment.text}</div>
  `;

  return div;
}

// Format timestamp
function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

  return date.toLocaleDateString();
}

// Initialize on load
init();
