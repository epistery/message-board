// Chat view for Message Board
import { MessageBoardCommon } from './message-board-common.mjs';

const mb = new MessageBoardCommon();
let currentImageDataUrl = null;
let currentChannel = null;
let channels = [];

// Initialize
async function init() {
  await mb.init();

  // Set up callback for post updates
  mb.onPostsUpdated = renderMessages;

  // Load channels
  await loadChannels();

  // Handle hash-based channel selection
  handleHashChange();
  window.addEventListener('hashchange', handleHashChange);

  // Setup event listeners
  setupEventListeners();

  // Initial render
  renderMessages();
  scrollToBottom();

  // Hide input if no edit permission
  if (!mb.permissions || !mb.permissions.edit) {
    hideInput();
  }
}

// Load channels
async function loadChannels() {
  try {
    const response = await fetch('/agent/epistery/message-board/api/channels');
    if (response.ok) {
      channels = await response.json();

      // Default to "general" channel if no channel selected
      if (!currentChannel && channels.length > 0) {
        currentChannel = 'general';
        mb.currentChannel = 'general';
      }

      renderChannels();
    }
  } catch (error) {
    console.error('[chat] Failed to load channels:', error);
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
      <a href="#" class="${currentChannel === channel.name ? 'active' : ''}" onclick="window.selectChannel('${channel.name}'); return false;">
        # ${escapeHtml(channel.name)}
      </a>
    </li>
  `).join('');

  // Update header
  const header = document.querySelector('.chat-header h1');
  if (header) {
    header.textContent = currentChannel ? `# ${currentChannel}` : '# general';
  }

  // Update input placeholder
  const input = document.getElementById('message-input');
  if (input) {
    input.placeholder = `Message #${currentChannel || 'general'}`;
  }
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
window.selectChannel = async function(channelName) {
  currentChannel = channelName;

  // Update URL hash (no hash for general)
  if (channelName === 'general') {
    if (window.location.hash) {
      history.pushState(null, '', window.location.pathname);
    }
  } else {
    window.location.hash = channelName;
  }

  renderChannels();

  // Reload posts for this channel
  mb.currentChannel = channelName;
  await mb.loadPosts();
  renderMessages();
  scrollToBottom();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Setup event listeners
function setupEventListeners() {
  const sendButton = document.getElementById('send-button');
  const messageInput = document.getElementById('message-input');
  const imageInput = document.getElementById('image-input');
  const imagePreview = document.getElementById('image-preview');

  if (sendButton) {
    sendButton.addEventListener('click', sendMessage);
  }

  if (messageInput) {
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  if (imageInput) {
    imageInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const previewContainer = document.getElementById('image-preview-container');
      if (previewContainer) {
        previewContainer.style.display = 'block';
      }

      imagePreview.src = 'data:image/svg+xml;base64,' + btoa(`
        <svg width="200" height="100" xmlns="http://www.w3.org/2000/svg">
          <rect width="200" height="100" fill="#f0f0f0"/>
          <text x="100" y="50" text-anchor="middle" font-family="Arial" font-size="14" fill="#666">
            Processing...
          </text>
        </svg>
      `);

      try {
        currentImageDataUrl = await mb.processImage(file);
        imagePreview.src = currentImageDataUrl;
      } catch (error) {
        console.error('[chat] Image processing error:', error);
        showError(error.message);
        imageInput.value = '';
        if (previewContainer) {
          previewContainer.style.display = 'none';
        }
        currentImageDataUrl = null;
      }
    });
  }
}

// Send message
async function sendMessage() {
  const messageInput = document.getElementById('message-input');
  const sendButton = document.getElementById('send-button');
  const imageInput = document.getElementById('image-input');
  const previewContainer = document.getElementById('image-preview-container');

  const text = messageInput.value.trim();
  if (!text) return;

  sendButton.disabled = true;
  sendButton.textContent = 'Sending...';

  try {
    await mb.createPost(text, currentImageDataUrl, currentChannel);

    messageInput.value = '';
    messageInput.style.height = 'auto';
    imageInput.value = '';
    if (previewContainer) {
      previewContainer.style.display = 'none';
    }
    currentImageDataUrl = null;

    // Wait for posts to be updated, then render and scroll
    setTimeout(() => {
      renderMessages();
      scrollToBottom();
    }, 100);
  } catch (error) {
    console.error('[chat] Send error:', error);
    showError(error.message);
  } finally {
    sendButton.disabled = false;
    sendButton.textContent = 'Send';
  }
}

// Persist open comment forms and drafts across re-renders so a WebSocket
// update doesn't wipe out a comment the user is composing.
const openCommentForms = new Set();
const commentDrafts = new Map();

// Render messages
function renderMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  // Snapshot any in-progress comment drafts before destroying the DOM.
  for (const postId of openCommentForms) {
    const input = document.getElementById(`comment-input-${postId}`);
    if (input) commentDrafts.set(postId, input.value);
  }

  if (mb.posts.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">💬</div>
        <p>No messages yet. Start the conversation!</p>
      </div>
    `;
    return;
  }

  // Render in reverse order (oldest first for chat view)
  const messages = [...mb.posts].reverse();
  container.innerHTML = messages.map(post => renderMessage(post)).join('');

  // Populate post and comment text in isolation. Setting innerHTML on each
  // element scopes the HTML parser to that element, so an unclosed tag from
  // markdown rendering can't leak out and wrap the comment form (which would
  // cause clicking the input to navigate as if it were inside an anchor).
  for (const post of messages) {
    const el = container.querySelector(`[data-post-text="${post.id}"]`);
    if (el) el.innerHTML = mb.markup ? mb.markup.render(post.text) : mb.escapeHtml(post.text);
    if (post.comments) {
      for (const c of post.comments) {
        const ce = container.querySelector(`[data-comment-text="${c.id}"]`);
        if (ce) ce.innerHTML = mb.markup ? mb.markup.render(c.text) : mb.escapeHtml(c.text);
      }
    }
  }

  // Re-open any forms that were open before the re-render and restore drafts.
  for (const postId of openCommentForms) {
    const form = document.getElementById(`comment-form-${postId}`);
    if (form) form.style.display = 'flex';
    const input = document.getElementById(`comment-input-${postId}`);
    if (input && commentDrafts.has(postId)) input.value = commentDrafts.get(postId);
  }
}

// Render single message
function renderMessage(post) {
  const date = new Date(post.timestamp);
  const timeAgo = mb.getTimeAgo(date);
  const shortAddress = post.author.substring(0, 8) + '...' + post.author.substring(post.author.length - 6);
  const avatar = mb.generateAvatar(post.author, 36);

  const authorDisplay = post.authorName || shortAddress;

  const imageHtml = post.image
    ? `<img src="${post.image}" class="message-image" alt="Attached image">`
    : '';

  const isOwnMessage = mb.currentUser &&
    mb.currentUser.address.toLowerCase() === post.author.toLowerCase();
  const canDelete = mb.currentUser &&
    (isOwnMessage || mb.permissions.admin);
  const canEdit = isOwnMessage;

  const commentsHtml = post.comments && post.comments.length > 0
    ? `<div class="comments">${post.comments.map(c => renderComment(post.id, c)).join('')}</div>`
    : '';

  const canComment = mb.permissions && mb.permissions.edit;

  return `
    <div class="message" data-message-id="${post.id}">
      <img src="${avatar}" class="message-avatar" alt="Avatar">
      <div class="message-content">
        <div class="message-header">
          <span class="message-author">${mb.escapeHtml(authorDisplay)}</span>
          <span class="clickable-address" onclick="window.copyAddress('${post.author}')" title="${post.author}">${shortAddress}</span>
          <span class="message-time">${timeAgo}</span>
        </div>
        <div class="message-text" data-post-text="${post.id}"></div>
        ${imageHtml}
        <div class="message-actions">
          ${canComment ? `<button type="button" class="message-action-btn icon icon-reply" title="Comment" aria-label="Comment" onclick="event.preventDefault();window.showCommentForm(${post.id});return false;"></button>` : ''}
          ${canEdit ? `<button type="button" class="message-action-btn icon icon-edit" title="Edit" aria-label="Edit" onclick="event.preventDefault();window.editMessage(${post.id});return false;"></button>` : ''}
          ${canDelete ? `<button type="button" class="message-action-btn icon icon-trash" title="Delete" aria-label="Delete" onclick="event.preventDefault();window.deleteMessage(${post.id});return false;"></button>` : ''}
        </div>
        ${commentsHtml}
        ${canComment ? `
          <div class="comment-form" id="comment-form-${post.id}" style="display: none;">
            <input type="text" id="comment-input-${post.id}" placeholder="Write a comment..." onkeydown="if(event.key==='Enter'){event.preventDefault();window.addComment(${post.id});}">
            <button type="button" onclick="event.preventDefault();window.addComment(${post.id});return false;">Post</button>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

// Render a single comment
function renderComment(postId, comment) {
  const date = new Date(comment.timestamp);
  const timeAgo = mb.getTimeAgo(date);
  const shortAddress = comment.author.substring(0, 8) + '...' + comment.author.substring(comment.author.length - 6);
  const avatar = mb.generateAvatar(comment.author, 28);
  const authorDisplay = comment.authorName || shortAddress;
  const canComment = mb.permissions && mb.permissions.edit;
  const replyHandle = (comment.authorName || shortAddress).replace(/'/g, "\\'");
  const isOwn = mb.currentUser && mb.currentUser.address.toLowerCase() === comment.author.toLowerCase();

  return `
    <div class="comment" data-comment-id="${comment.id}">
      <div class="comment-with-avatar">
        <img src="${avatar}" class="avatar avatar-small" alt="Avatar">
        <div class="comment-content">
          <div class="comment-header">
            <span class="comment-author">${mb.escapeHtml(authorDisplay)}</span>
            <span class="clickable-address" onclick="window.copyAddress('${comment.author}')" title="${comment.author}">${shortAddress}</span>
            <span class="comment-time">${timeAgo}</span>
            <div class="comment-actions">
              ${canComment ? `<button type="button" class="message-action-btn icon icon-reply" title="Reply" aria-label="Reply" onclick="event.preventDefault();window.replyToComment(${postId}, '${replyHandle}');return false;"></button>` : ''}
              ${isOwn ? `<button type="button" class="message-action-btn icon icon-edit" title="Edit" aria-label="Edit" onclick="event.preventDefault();window.editComment(${postId}, ${comment.id});return false;"></button>` : ''}
              ${isOwn ? `<button type="button" class="message-action-btn icon icon-trash" title="Delete" aria-label="Delete" onclick="event.preventDefault();window.deleteComment(${postId}, ${comment.id});return false;"></button>` : ''}
            </div>
          </div>
          <div class="comment-text" data-comment-text="${comment.id}"></div>
        </div>
      </div>
    </div>
  `;
}

// Edit a comment inline
window.editComment = function(postId, commentId) {
  const post = mb.posts.find(p => p.id === postId);
  if (!post) return;
  const comment = (post.comments || []).find(c => c.id === commentId);
  if (!comment) return;
  const commentEl = document.querySelector(`[data-comment-id="${commentId}"]`);
  if (!commentEl) return;
  const textEl = commentEl.querySelector('.comment-text');
  const actionsEl = commentEl.querySelector('.comment-actions');
  if (!textEl || !actionsEl) return;

  textEl.innerHTML = `<textarea id="edit-comment-${commentId}" class="edit-textarea" rows="3" style="width:100%;font:inherit;"></textarea>`;
  document.getElementById(`edit-comment-${commentId}`).value = comment.text;
  actionsEl.innerHTML = `
    <button type="button" class="message-action-btn icon icon-save" title="Save" aria-label="Save" onclick="event.preventDefault();window.saveCommentEdit(${postId}, ${commentId});return false;"></button>
    <button type="button" class="message-action-btn icon icon-cross" title="Cancel" aria-label="Cancel" onclick="event.preventDefault();window.cancelCommentEdit();return false;"></button>
  `;
  const ta = document.getElementById(`edit-comment-${commentId}`);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
};

window.saveCommentEdit = async function(postId, commentId) {
  const ta = document.getElementById(`edit-comment-${commentId}`);
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) {
    showError('Comment cannot be empty');
    return;
  }
  try {
    await mb.editComment(postId, commentId, text);
  } catch (error) {
    console.error('[chat] Edit comment error:', error);
    showError(error.message);
  }
};

window.deleteComment = async function(postId, commentId) {
  if (!confirm('Delete this comment?')) return;
  try {
    await mb.deleteComment(postId, commentId);
  } catch (error) {
    console.error('[chat] Delete comment error:', error);
    showError(error.message);
  }
};

window.cancelCommentEdit = function() { renderMessages(); };

// Show / hide the comment form
window.showCommentForm = function(postId) {
  const form = document.getElementById(`comment-form-${postId}`);
  if (!form) return;
  const willOpen = form.style.display === 'none';
  form.style.display = willOpen ? 'flex' : 'none';
  if (willOpen) {
    openCommentForms.add(postId);
    const input = document.getElementById(`comment-input-${postId}`);
    if (input) input.focus();
  } else {
    openCommentForms.delete(postId);
    commentDrafts.delete(postId);
  }
};

// Reply to a comment — adds another comment to the original post,
// prefilled with @handle so the threading intent is preserved (one level deep).
window.replyToComment = function(postId, handle) {
  const form = document.getElementById(`comment-form-${postId}`);
  const input = document.getElementById(`comment-input-${postId}`);
  if (!form || !input) return;
  form.style.display = 'flex';
  openCommentForms.add(postId);
  const mention = `@${handle} `;
  if (!input.value.startsWith(mention)) input.value = mention + input.value;
  commentDrafts.set(postId, input.value);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
};

// Submit a comment
window.addComment = async function(postId) {
  const input = document.getElementById(`comment-input-${postId}`);
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  try {
    await mb.addComment(postId, text);
    input.value = '';
    openCommentForms.delete(postId);
    commentDrafts.delete(postId);
    renderMessages();
    scrollToBottom();
  } catch (error) {
    console.error('[chat] Comment error:', error);
    showError(error.message);
  }
};

// Edit message — replace the message text with an inline textarea
window.editMessage = function(postId) {
  const post = mb.posts.find(p => p.id === postId);
  if (!post) return;
  const messageEl = document.querySelector(`[data-message-id="${postId}"]`);
  if (!messageEl) return;
  const textEl = messageEl.querySelector('.message-text');
  const actionsEl = messageEl.querySelector('.message-actions');
  if (!textEl || !actionsEl) return;

  textEl.innerHTML = `<textarea id="edit-textarea-${postId}" class="edit-textarea" rows="3" style="width:100%;font:inherit;"></textarea>`;
  const ta = document.getElementById(`edit-textarea-${postId}`);
  ta.value = post.text;

  actionsEl.innerHTML = `
    <button type="button" class="message-action-btn icon icon-save" title="Save" aria-label="Save" onclick="event.preventDefault();window.saveEdit(${postId});return false;"></button>
    <button type="button" class="message-action-btn icon icon-cross" title="Cancel" aria-label="Cancel" onclick="event.preventDefault();window.cancelEdit(${postId});return false;"></button>
  `;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
};

window.saveEdit = async function(postId) {
  const ta = document.getElementById(`edit-textarea-${postId}`);
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) {
    showError('Message cannot be empty');
    return;
  }
  try {
    const response = await fetch(`/agent/epistery/message-board/api/posts/${postId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text })
    });
    if (!response.ok) {
      const ct = response.headers.get('content-type');
      if (ct && ct.includes('application/json')) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to update message');
      }
      throw new Error(`Failed to update message (${response.status})`);
    }
    const post = mb.posts.find(p => p.id === postId);
    if (post) post.text = text;
    renderMessages();
  } catch (error) {
    console.error('[chat] Edit error:', error);
    showError(error.message);
  }
};

window.cancelEdit = function() {
  renderMessages();
};

// Delete message
window.deleteMessage = async function(postId) {
  if (!confirm('Delete this message?')) return;

  try {
    await mb.deletePost(postId);
    renderMessages();
  } catch (error) {
    console.error('[chat] Delete error:', error);
    showError(error.message);
  }
};

// Copy address
window.copyAddress = async function(address) {
  await mb.copyAddress(address);
};

// Show error
function showError(message) {
  const container = document.getElementById('error-container');
  if (!container) return;

  const errorEl = document.createElement('div');
  errorEl.className = 'error-message';
  errorEl.textContent = message;
  container.appendChild(errorEl);

  setTimeout(() => errorEl.remove(), 5000);
}

// Hide input for users without permission
function hideInput() {
  const inputContainer = document.getElementById('chat-input-container');
  if (inputContainer) {
    inputContainer.style.display = 'none';
  }
}

// Scroll to bottom
function scrollToBottom() {
  const messagesContainer = document.getElementById('chat-messages');
  if (messagesContainer) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

// Start app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
