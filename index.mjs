import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { Config } from 'epistery';
import crypto from 'crypto';
import https from "https";
import http from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Message Board Agent
 *
 * Provides a discussion board / posting wall for epistery hosts.
 * Access control via white-list integration and notabot scores.
 * Posts are stored on IPFS as Data Wallets with user + server signatures.
 * Batching: 5 posts before paying gas to store on-chain.
 * This is the main entry point loaded by AgentManager.
 */
export default class MessageBoardAgent {
  constructor(manifestConfig = {}) {
    this.manifestConfig = manifestConfig;
    this.rootConfig = (new Config()).read('/');
    this.epistery = null;
    this.wss = null;

    // Batch chain for posts (Proof of Stake - server earns right to batch)
    this.postChain = [];
    this.lastHash = '0000000000000000000000000000000000000000000000000000000000000000';

    // Per-domain state (keyed by domain)
    this.domainStates = new Map();

  }

  getDomainConfig(domain) {
    const config = new Config();
    config.setPath(domain);

    if (!config.data.messageBoard) {
      config.data.messageBoard = {
        minNotabotPoints: this.manifestConfig.minNotabotPoints || 10,
        postingList: this.manifestConfig.postingList || 'message-board::posting',
        moderatorList: this.manifestConfig.moderatorList || 'message-board::moderators',
        batchThreshold: this.manifestConfig.batchThreshold || 5, // Posts before on-chain flush
        imageSettings: {
          maxUploadSize: this.manifestConfig.imageSettings?.maxUploadSize || 10, // MB
          maxProcessedSize: this.manifestConfig.imageSettings?.maxProcessedSize || 3, // MB
          maxWidth: this.manifestConfig.imageSettings?.maxWidth || 1024, // pixels
          jpegQuality: this.manifestConfig.imageSettings?.jpegQuality || 85, // 0-100
          allowSvg: this.manifestConfig.imageSettings?.allowSvg !== undefined ? this.manifestConfig.imageSettings.allowSvg : true
        }
      }
      config.save();
    }
    return config;
  }
  /**
   * Get or initialize domain state
   */
  getDomainState(domain) {
    if (!this.domainStates.has(domain)) {
      const config = new Config();
      config.setPath(domain);

      const batchData = config.readFile('message-board-batch.json') || {
        chain: [],
        lastHash: this.lastHash,
        lastFlush: Date.now()
      };

      this.domainStates.set(domain, {
        postChain: batchData.chain || [],
        lastHash: batchData.lastHash || this.lastHash
      });
    }
    return this.domainStates.get(domain);
  }

  /**
   * Attach the agent to an Express router
   * Called by AgentManager after instantiation
   *
   * @param {express.Router} router - Express router instance
   */
  attach(router) {
    router.use((req, res, next) => {
      req.domain = req.hostname || 'localhost';
      req.boardConfig = this.getDomainConfig(req.domain);
      if (!this.epistery && req.app.locals.epistery) {
        this.epistery = req.app.locals.epistery;
      }
      next();
    });

    // Redirect root to board
    router.get('/', (req, res) => {
      res.redirect(req.baseUrl + '/board');
    });

    // Serve static files
    router.use('/static', express.static(path.join(__dirname, 'public')));

    // Serve icon
    router.get('/icon.svg', (req, res) => {
      const iconPath = path.join(__dirname, 'icon.svg');
      if (!existsSync(iconPath)) {
        return res.status(404).send('Icon not found');
      }
      res.set('Content-Type', 'image/svg+xml');
      res.sendFile(iconPath);
    });

    // Serve widget (for agent box)
    router.get('/widget', (req, res) => {
      const widgetPath = path.join(__dirname, 'client/widget.html');
      if (!existsSync(widgetPath)) {
        return res.status(404).send('Widget not found');
      }
      res.sendFile(widgetPath);
    });

    // Serve admin page
    router.get('/admin', (req, res) => {
      const adminPath = path.join(__dirname, 'client/admin.html');
      if (!existsSync(adminPath)) {
        return res.status(404).send('Admin page not found');
      }
      res.sendFile(adminPath);
    });

    // Serve board page (main UI)
    router.get('/board', (req, res) => {
      const boardPath = path.join(__dirname, 'client/board.html');
      if (!existsSync(boardPath)) {
        return res.status(404).send('Board page not found');
      }
      res.sendFile(boardPath);
    });

    // API Routes

    // Health check
    router.get('/api/health', (req, res) => {
      const boardConfig = req.boardConfig.data.messageBoard;
      res.json({
        status: 'ok',
        agent: 'message-board',
        version: '1.0.0',
        config: {
          minNotabotPoints: boardConfig.minNotabotPoints,
          postingList: boardConfig.postingList,
          moderatorList: boardConfig.moderatorList
        }
      });
    });

    // Get sidebar links
    router.get('/links', (req, res) => {
      const links = this.loadSidebarLinks(req.domain);
      res.json(links);
    });

    // Add sidebar link (requires moderator permission)
    router.post('/links', async (req, res) => {
      try {
        const permission = await this.checkModeratorPermission(req);
        if (!permission.allowed) {
          return res.status(403).json({ error: 'Only moderators can manage links' });
        }

        const { title, url } = req.body;
        if (!title || !url) {
          return res.status(400).json({ error: 'Title and URL are required' });
        }

        const links = this.loadSidebarLinks(req.domain);
        links.push({ title, url });
        this.saveSidebarLinks(req.domain, links);

        res.json({ success: true, links });
      } catch (error) {
        console.error('[message-board] Error adding link:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Delete sidebar link (requires moderator permission)
    router.delete('/links/:index', async (req, res) => {
      try {
        const permission = await this.checkModeratorPermission(req);
        if (!permission.allowed) {
          return res.status(403).json({ error: 'Only moderators can manage links' });
        }

        const index = parseInt(req.params.index);
        const links = this.loadSidebarLinks(req.domain);

        if (index < 0 || index >= links.length) {
          return res.status(404).json({ error: 'Link not found' });
        }

        links.splice(index, 1);
        this.saveSidebarLinks(req.domain, links);

        res.json({ success: true, links });
      } catch (error) {
        console.error('[message-board] Error deleting link:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Get image settings
    router.get('/api/settings/image', (req, res) => {
      const imageSettings = req.boardConfig.data.messageBoard.imageSettings;
      res.json(imageSettings);
    });

    // Update image settings (requires moderator permission)
    router.patch('/api/settings/image', async (req, res) => {
      try {
        // Check moderator permission
        const permission = await this.checkModeratorPermission(req);
        if (!permission.allowed) {
          return res.status(403).json({ error: 'Only moderators can update settings' });
        }

        const updates = req.body;
        const validFields = ['maxUploadSize', 'maxProcessedSize', 'maxWidth', 'jpegQuality', 'allowSvg'];
        const imageSettings = req.boardConfig.data.messageBoard.imageSettings;

        // Validate and apply updates
        for (const [key, value] of Object.entries(updates)) {
          if (!validFields.includes(key)) {
            return res.status(400).json({ error: `Invalid setting: ${key}` });
          }

          // Validate ranges
          if (key === 'maxUploadSize' && (value < 1 || value > 50)) {
            return res.status(400).json({ error: 'maxUploadSize must be between 1 and 50 MB' });
          }
          if (key === 'maxProcessedSize' && (value < 0.5 || value > 10)) {
            return res.status(400).json({ error: 'maxProcessedSize must be between 0.5 and 10 MB' });
          }
          if (key === 'maxWidth' && (value < 256 || value > 4096)) {
            return res.status(400).json({ error: 'maxWidth must be between 256 and 4096 pixels' });
          }
          if (key === 'jpegQuality' && (value < 50 || value > 100)) {
            return res.status(400).json({ error: 'jpegQuality must be between 50 and 100' });
          }
          if (key === 'allowSvg' && typeof value !== 'boolean') {
            return res.status(400).json({ error: 'allowSvg must be a boolean' });
          }

          imageSettings[key] = value;
        }

        // Save settings to config
        req.boardConfig.save();

        res.json({ success: true, settings: imageSettings });
      } catch (error) {
        console.error('[message-board] Update settings error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Get all posts (public, read-only)
    router.get('/api/posts', (req, res) => {
      try {
        const data = this.readData(req.domain);
        res.json(data.posts);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Create new post (requires auth + permission)
    router.post('/api/posts', async (req, res) => {
      try {
        console.log('[message-board] Received post request');

        const { text, image } = req.body;

        //TODO: Text is not required if an image is attached
        if (!text || text.trim().length === 0) {
          return res.status(400).json({ error: 'Text is required' });
        }

        // Validate image if provided
        if (image) {
          const imageSettings = req.boardConfig.data.messageBoard.imageSettings;

          // Check if it's a data URL
          if (!image.startsWith('data:image/')) {
            return res.status(400).json({ error: 'Invalid image format' });
          }

          // Check size using configured limit
          const sizeInBytes = Math.round((image.length * 3) / 4);
          const maxSize = imageSettings.maxProcessedSize * 1024 * 1024;
          if (sizeInBytes > maxSize) {
            return res.status(400).json({
              error: `Image too large. Maximum size is ${imageSettings.maxProcessedSize}MB.`
            });
          }

          // Validate image type
          const isJpeg = image.startsWith('data:image/jpeg');
          const isSvg = image.startsWith('data:image/svg+xml');

          if (!isJpeg && !isSvg) {
            return res.status(400).json({ error: 'Only JPEG and SVG images are allowed' });
          }

          // Check if SVG is allowed
          if (isSvg && !imageSettings.allowSvg) {
            return res.status(400).json({ error: 'SVG images are not allowed on this board' });
          }

          // Sanitize SVG if provided
          if (isSvg) {
            try {
              const sanitizedSvg = this.sanitizeSvg(image);
              // Replace original with sanitized version
              req.body.image = sanitizedSvg;
            } catch (error) {
              console.error('[message-board] SVG sanitization error:', error);
              return res.status(400).json({ error: 'Invalid or malicious SVG content' });
            }
          }
        }

        // Check posting permission
        console.log('[message-board] Checking posting permission...');
        const permission = await this.checkPostingPermission(req);
        console.log('[message-board] Permission result:', permission);

        if (!permission.allowed) {
          const boardConfig = req.boardConfig.data.messageBoard;
          return res.status(403).json({
            error: permission.reason,
            requiresNotabotPoints: boardConfig.minNotabotPoints
          });
        }

        const data = this.readData(req.domain);
        const post = {
          id: data.nextId++,
          text: text.trim(),
          image: image || null,
          author: permission.user.address,
          authorName: permission.user.name || null,
          timestamp: Date.now(),
          comments: []
        };

        // Add to local storage
        data.posts.unshift(post);
        this.writeData(req.domain, data);

        // Broadcast immediately
        this.broadcast({ type: 'new-post', post }, req.domain);

        // Send response to user immediately
        res.json(post);

        // Add to IPFS batch chain asynchronously (invisible to user)
        // This creates Data Wallet: user owns content with cryptographic proof
        setImmediate(async () => {
          try {
            const chainedPost = await this.addPostToBatch(post, null, req.domain); // TODO: Get user signature from client
            if (chainedPost.ipfsHash) {
              console.log(`[message-board] Post ${post.id} stored as Data Wallet: ${chainedPost.ipfsUrl}`);
            }
          } catch (error) {
            console.error('[message-board] IPFS batching error (non-fatal):', error);
            // Continue even if IPFS fails - local storage succeeded
          }
        });
      } catch (error) {
        console.error('[message-board] Post error:', error);
        console.error('[message-board] Stack trace:', error.stack);
        res.status(500).json({ error: error.message });
      }
    });

    // Check if user has posting permission (without actually posting)
    router.post('/api/check-permission', async (req, res) => {
      try {
        const permission = await this.checkPostingPermission(req);
        res.json({
          canPost: permission.allowed,
          reason: permission.reason,
          user: permission.user
        });
      } catch (error) {
        console.error('[message-board] Permission check error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Add comment to post (requires auth + permission)
    router.post('/api/posts/:id/comments', async (req, res) => {
      try {
        const postId = parseInt(req.params.id);
        const { text } = req.body;

        if (!text || text.trim().length === 0) {
          return res.status(400).json({ error: 'Text is required' });
        }

        // Check posting permission
        const permission = await this.checkPostingPermission(req);
        if (!permission.allowed) {
          const boardConfig = req.boardConfig.data.messageBoard;
          return res.status(403).json({
            error: permission.reason,
            requiresNotabotPoints: boardConfig.minNotabotPoints
          });
        }

        const data = this.readData(req.domain);
        const post = data.posts.find(p => p.id === postId);

        if (!post) {
          return res.status(404).json({ error: 'Post not found' });
        }

        const comment = {
          id: Date.now(),
          text: text.trim(),
          author: permission.user.address,
          authorName: permission.user.name || null,
          timestamp: Date.now()
        };

        post.comments.push(comment);
        this.writeData(req.domain, data);

        this.broadcast({ type: 'new-comment', postId, comment }, req.domain);
        res.json(comment);
      } catch (error) {
        console.error('[message-board] Comment error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Delete post (moderators only)
    router.delete('/api/posts/:id', async (req, res) => {
      try {
        const postId = parseInt(req.params.id);

        // Get authenticated user
        const sameDomainAuth = await this.verifySameDomainAuth(req);
        if (!sameDomainAuth.valid) {
          return res.status(401).json({ error: 'Authentication required' });
        }

        const userAddress = sameDomainAuth.address;
        const data = this.readData(req.domain);
        const post = data.posts.find(p => p.id === postId);

        if (!post) {
          return res.status(404).json({ error: 'Post not found' });
        }

        // Check if user can delete this post
        // Allow: post author OR epistery::admin OR {domain}::admin OR message-board::moderators
        const isAuthor = post.author === userAddress;
        const modPermission = await this.checkModeratorPermission(req);
        const canDelete = isAuthor || modPermission.allowed;

        if (!canDelete) {
          return res.status(403).json({
            error: 'You can only delete your own posts unless you are a moderator'
          });
        }

        // Delete the post
        const index = data.posts.findIndex(p => p.id === postId);
        data.posts.splice(index, 1);
        this.writeData(req.domain, data);

        this.broadcast({ type: 'delete-post', postId }, req.domain);
        res.json({ success: true });
      } catch (error) {
        console.error('[message-board] Delete error:', error);
        res.status(500).json({ error: error.message });
      }
    });
    // API endpoint to get links
    router.get('/api/links', async (req, res) => {
      try {
        const domain = req.headers.host?.split(':')[0] || 'localhost';
        const cfg = new Config();
        cfg.setPath(domain);

        const links = cfg.data?.links || [];
        res.json({ links });
      } catch (error) {
        console.error('[get-links] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API endpoint to save/update links (requires admin auth)
    router.post('/api/links', async (req, res) => {
      try {
        const { slug, url, title } = req.body;
        const domain = req.headers.host?.split(':')[0] || 'localhost';

        if (!slug || !url) {
          return res.status(400).json({ error: 'slug and url are required' });
        }

        // Check if user is admin
        if (!req.episteryClient || !req.app.locals.epistery) {
          return res.status(401).json({ error: 'Not authenticated' });
        }

        const isAdmin = await req.app.locals.epistery.isListed(req.episteryClient.address, 'epistery::admin');
        if (!isAdmin) {
          return res.status(403).json({ error: 'Not authorized' });
        }

        const cfg = new Config();
        cfg.setPath(domain);

        if (!cfg.data.links) {
          cfg.data.links = [];
        }

        // Check if link exists and update, or add new
        const existingIndex = cfg.data.links.findIndex(l => l.slug === slug);
        const link = { slug, url, title: title || slug };

        if (existingIndex >= 0) {
          cfg.data.links[existingIndex] = link;
        } else {
          cfg.data.links.push(link);
        }

        cfg.save();

        res.json({ success: true, link });
      } catch (error) {
        console.error('[save-link] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API endpoint to delete link (requires admin auth)
    router.delete('/api/links/:slug', async (req, res) => {
      try {
        const { slug } = req.params;
        const domain = req.headers.host?.split(':')[0] || 'localhost';

        // Check if user is admin
        if (!req.episteryClient || !req.app.locals.epistery) {
          return res.status(401).json({ error: 'Not authenticated' });
        }

        const isAdmin = await req.app.locals.epistery.isListed(req.episteryClient.address, 'epistery::admin');
        if (!isAdmin) {
          return res.status(403).json({ error: 'Not authorized' });
        }

        const cfg = new Config();
        cfg.setPath(domain);

        if (!cfg.data.links) {
          return res.status(404).json({ error: 'Link not found' });
        }

        const initialLength = cfg.data.links.length;
        cfg.data.links = cfg.data.links.filter(l => l.slug !== slug);

        if (cfg.data.links.length === initialLength) {
          return res.status(404).json({ error: 'Link not found' });
        }

        cfg.save();

        res.json({ success: true });
      } catch (error) {
        console.error('[delete-link] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Status endpoint
    router.get('/status', (req, res) => {
      const data = this.readData(req.domain);
      const boardConfig = req.boardConfig.data.messageBoard;
      res.json({
        agent: 'message-board',
        version: '1.0.0',
        postCount: data.posts.length,
        config: boardConfig
      });
    });

    console.log('[message-board] Agent routes attached');
  }

  /**
   * Check if user has permission to post
   * Hierarchy: Global Admin > Domain Admin > Posting Whitelist > Notabot Points
   * NOTE: Authentication not implemented - delegation removed
   */
  async checkPostingPermission(req) {
    // Try same-domain authentication
    const sameDomainAuth = await this.verifySameDomainAuth(req);
    let address, verification;

    if (sameDomainAuth.valid) {
      address = sameDomainAuth.address;
      verification = sameDomainAuth;
      console.log(`[message-board] Using same-domain auth for ${address}`);
    } else {
      console.log('[message-board] No valid authentication - delegation removed');
      return { allowed: false, reason: 'Authentication not implemented' };
    }

    // Check permission hierarchy
    if (this.epistery) {
      try {
        // 1. Check if global admin (highest privilege)
        console.log(`[message-board] Checking global admin for ${address}`);
        const isGlobalAdmin = await this.epistery.isListed(address, 'epistery::admin');
        console.log(`[message-board] Global admin check result:`, isGlobalAdmin);

        if (isGlobalAdmin) {
          const userName = await this.getUserName(req, address, 'epistery::admin');
          console.log(`[message-board] User ${address} allowed as global admin (name: ${userName})`);
          return {
            allowed: true,
            user: { address, name: userName || verification.name },
            method: 'global-admin'
          };
        }

        // 2. Check if domain admin
        // Format: {resource}::{role}
        const domainAdminList = `${verification.domain}::admin`;
        console.log(`[message-board] Checking domain admin for ${address} on list ${domainAdminList}`);
        const isDomainAdmin = await this.epistery.isListed(address, domainAdminList);
        console.log(`[message-board] Domain admin check result:`, isDomainAdmin);

        if (isDomainAdmin) {
          // Fetch user's display name from white-list
          const userName = await this.getUserName(req, address, domainAdminList);
          console.log(`[message-board] User ${address} allowed as domain admin (name: ${userName})`);
          return {
            allowed: true,
            user: { address, name: userName || verification.name },
            method: 'domain-admin'
          };
        }

        // 3. Check if on posting whitelist
        const boardConfig = req.boardConfig.data.messageBoard;
        console.log(`[message-board] Checking posting whitelist for ${address} on list ${boardConfig.postingList}`);
        const isOnPostingList = await this.epistery.isListed(address, boardConfig.postingList);
        console.log(`[message-board] Posting whitelist check result:`, isOnPostingList);

        if (isOnPostingList) {
          const userName = await this.getUserName(req, address, boardConfig.postingList);
          console.log(`[message-board] User ${address} allowed via posting whitelist (name: ${userName})`);
          return {
            allowed: true,
            user: { address, name: userName || verification.name },
            method: 'posting-whitelist'
          };
        }
      } catch (error) {
        console.error('[message-board] Permission check failed:', error);
        console.error('[message-board] Error stack:', error.stack);
      }
    } else {
      console.warn('[message-board] Epistery instance not available, allowing all authenticated users');
      // If epistery not available (development mode), allow all authenticated users
      return {
        allowed: true,
        user: { address, name: verification.name },
        method: 'dev-mode'
      };
    }

    // 4. Default: Allow all authenticated users (simplified for v1.0)
    // Notabot points are collected but not enforced - agents can add their own rules later
    console.log(`[message-board] User ${address} allowed as authenticated user`);
    return {
      allowed: true,
      user: { address, name: verification.name },
      method: 'authenticated'
    };
  }

  /**
   * Check if user has moderator permission
   */
  async checkModeratorPermission(req) {
    const sameDomainAuth = await this.verifySameDomainAuth(req);

    if (!sameDomainAuth.valid) {
      return { allowed: false, reason: 'Authentication required' };
    }

    const address = sameDomainAuth.address;

    if (this.epistery) {
      try {
        // Check global admin
        const isGlobalAdmin = await this.epistery.isListed(address, 'epistery::admin');
        if (isGlobalAdmin) {
          return { allowed: true, user: { address }, method: 'global-admin' };
        }

        // Check domain admin
        const domainAdminList = `${sameDomainAuth.domain}::admin`;
        const isDomainAdmin = await this.epistery.isListed(address, domainAdminList);
        if (isDomainAdmin) {
          return { allowed: true, user: { address }, method: 'domain-admin' };
        }

        // Check moderator list
        const boardConfig = req.boardConfig.data.messageBoard;
        const isModerator = await this.epistery.isListed(address, boardConfig.moderatorList);
        if (isModerator) {
          return { allowed: true, user: { address }, method: 'moderator' };
        }
      } catch (error) {
        console.error('[message-board] Moderator permission check failed:', error);
      }
    }

    return { allowed: false, reason: 'Moderator permission required' };
  }

  /**
   * Sanitize SVG content to remove potentially malicious code
   * This is a simple sanitization - for production, consider using a library like DOMPurify
   */
  sanitizeSvg(dataUrl) {
    // Extract SVG content from data URL
    const base64Match = dataUrl.match(/^data:image\/svg\+xml;base64,(.+)$/);
    let svgContent;

    if (base64Match) {
      svgContent = Buffer.from(base64Match[1], 'base64').toString('utf8');
    } else {
      // Try URL encoded
      const urlMatch = dataUrl.match(/^data:image\/svg\+xml,(.*?)$/);
      if (urlMatch) {
        svgContent = decodeURIComponent(urlMatch[1]);
      } else {
        throw new Error('Invalid SVG data URL format');
      }
    }

    // Remove dangerous elements and attributes
    const dangerous = {
      tags: ['script', 'iframe', 'object', 'embed', 'link', 'style', 'meta', 'base'],
      attributes: ['onload', 'onerror', 'onclick', 'onmouseover', 'onmouseout', 'onmousemove',
                   'onmouseenter', 'onmouseleave', 'onfocus', 'onblur', 'onchange', 'oninput',
                   'onsubmit', 'onkeydown', 'onkeyup', 'onkeypress', 'xmlns:xlink'],
      protocols: ['javascript:', 'data:text/html', 'vbscript:']
    };

    // Remove dangerous tags
    for (const tag of dangerous.tags) {
      svgContent = svgContent.replace(new RegExp(`<${tag}[^>]*>.*?</${tag}>`, 'gis'), '');
      svgContent = svgContent.replace(new RegExp(`<${tag}[^>]*/>`, 'gi'), '');
    }

    // Remove dangerous attributes
    for (const attr of dangerous.attributes) {
      svgContent = svgContent.replace(new RegExp(`\\s${attr}\\s*=\\s*["'][^"']*["']`, 'gi'), '');
      svgContent = svgContent.replace(new RegExp(`\\s${attr}\\s*=\\s*[^\\s>]*`, 'gi'), '');
    }

    // Remove dangerous protocols from href and xlink:href
    for (const protocol of dangerous.protocols) {
      svgContent = svgContent.replace(new RegExp(`(href|xlink:href)\\s*=\\s*["']${protocol}[^"']*["']`, 'gi'), '');
    }

    // Ensure it starts with <svg and ends with </svg>
    if (!svgContent.trim().match(/^<svg[\s>]/i)) {
      throw new Error('SVG must start with <svg> tag');
    }
    if (!svgContent.trim().match(/<\/svg>\s*$/i)) {
      throw new Error('SVG must end with </svg> tag');
    }

    // Re-encode as data URL
    const sanitizedBase64 = Buffer.from(svgContent).toString('base64');
    return `data:image/svg+xml;base64,${sanitizedBase64}`;
  }

  /**
   * Get user's display name from white-list
   */
  async getUserName(req, address, listName) {
    if (!this.epistery) {
      return null;
    }

    try {
      // Query the white-list agent API for members of this list
      const url = `http://localhost:${process.env.PORT || 4080}/agent/epistery/white-list/list?list=${encodeURIComponent(listName)}`;
      console.log(`[message-board] Fetching user name from: ${url}`);

      const response = await fetch(url);

      if (!response.ok) {
        console.error(`[message-board] Failed to fetch members from ${listName}: ${response.status}`);
        return null;
      }

      const data = await response.json();
      console.log(`[message-board] Received ${data.count} members from ${listName}`);

      // If there are multiple entries for the same address, prefer the one with a non-empty name
      const members = data.list.filter(m => m && m.address && m.address.toLowerCase() === address.toLowerCase());
      const member = members.find(m => m.name && m.name.trim() !== '') || members[0];

      console.log(`[message-board] Found member for ${address}:`, member);

      return member?.name || null;
    } catch (error) {
      console.error(`[message-board] Error fetching user name from white-list:`, error);
      return null;
    }
  }

  /**
   * Verify same-domain authentication (user's wallet address from header)
   * For same-domain scenarios, we trust the address if user is domain admin
   */
  async verifySameDomainAuth(req) {
    try {
      console.log('[message-board] verifySameDomainAuth - all headers:', req.headers);
      const address = req.headers['x-wallet-address'];

      if (!address) {
        console.log('[message-board] verifySameDomainAuth - no wallet address header found');
        return { valid: false, error: 'No wallet address provided' };
      }

      console.log('[message-board] verifySameDomainAuth - checking address:', address);

      // Verify this address is on domain admin white-list
      // Format: {resource}::{role} where resource is domain name, role is access level
      if (this.epistery) {
        const isGlobalAdmin = await this.isListedCaseInsensitive(address, 'epistery::admin');
        if (isGlobalAdmin) {
          console.log('[message-board] Same-domain auth successful for global admin');
          return { valid: true, address, isGlobalAdmin: true, domain: req.domain };
        }

        const isDomainAdmin = await this.isListedCaseInsensitive(address, `${req.domain}::admin`);
        if (isDomainAdmin) {
          console.log('[message-board] Same-domain auth successful for domain admin');
          return { valid: true, address, isDomainAdmin: true, domain: req.domain };
        }
      }

      console.log('[message-board] Same-domain auth failed - not an admin');
      return { valid: false, error: 'Not authorized' };
    } catch (error) {
      console.error('[message-board] Same-domain auth error:', error);
      return { valid: false, error: error.message };
    }
  }

  /**
   * Case-insensitive whitelist check
   * Ethereum addresses are case-insensitive but string comparison is not
   */
  async isListedCaseInsensitive(address, listName) {
    const list = await this.epistery.getList(listName);
    const addressLower = address.toLowerCase();
    return list.some(entry => entry.addr.toLowerCase() === addressLower);
  }

  /**
   * Authentication not implemented - delegation tokens removed
   * TODO: Implement direct rivet authentication
   */
  async verifyDelegationToken(req) {
    console.log('[message-board] Authentication not implemented - delegation removed');
    return { valid: false, error: 'Authentication not implemented' };
  }

  /**
   * Read posts data from domain-specific file
   */
  readData(domain) {
    const config = new Config();
    config.setPath(domain);

    try {
      const data = config.readFile('message-board-posts.json');
      return JSON.parse(data.toString());
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { posts: [], nextId: 1 };
      }
      throw error;
    }
  }

  /**
   * Write posts data to domain-specific file
   */
  writeData(domain, data) {
    const config = new Config();
    config.setPath(domain);
    // Ensure directory exists by saving config first
    config.save();
    config.writeFile('message-board-posts.json', JSON.stringify(data, null, 2));
  }

  /**
   * Broadcast message to WebSocket clients on a specific domain
   */
  broadcast(message, domain) {
    if (!this.wss) return;

    this.wss.clients.forEach(client => {
      if (client.readyState === 1 && client.domain === domain) {
        client.send(JSON.stringify(message));
      }
    });
  }

  /**
   * Initialize WebSocket server
   * @param {http.Server} server - HTTP server instance
   */
  initWebSocket(server) {
    this.wss = new WebSocketServer({ server, path: '/agent/epistery/message-board/ws' });

    this.wss.on('connection', (ws, req) => {
      // Track which domain this client connected from
      ws.domain = req.headers.host?.split(':')[0];
      console.log(`[message-board] WebSocket client connected from ${ws.domain}`);

      ws.on('close', () => {
        console.log(`[message-board] WebSocket client disconnected from ${ws.domain}`);
      });
    });

    console.log('[message-board] WebSocket server initialized');
  }

  /**
   * Create hash of post data for chain
   */
  hashPost(post, previousHash) {
    const data = JSON.stringify({
      ...post,
      previousHash: previousHash
    });
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Sign data with server wallet
   */
  async signPostAsServer(postData) {
    if (!this.epistery || !this.epistery.domain?.wallet) {
      console.warn('[message-board] Server wallet not available for signing');
      return null;
    }

    try {
      const dataHash = crypto.createHash('sha256').update(JSON.stringify(postData)).digest('hex');
      // TODO: Implement actual signature with server wallet private key
      // For now, return a placeholder signature
      return {
        hash: dataHash,
        signature: '0x...' // Placeholder
      };
    } catch (error) {
      console.error('[message-board] Server signing failed:', error);
      return null;
    }
  }

  /**
   * Upload data to IPFS
   */
  async uploadToIPFS(data) {
    if (!this.rootConfig.ipfs.url) {
      console.warn('[message-board] IPFS URL not configured, skipping IPFS upload');
      return null;
    }

    try {
      const formData = new FormData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      formData.append('file', blob, 'post.json');

      const response = await fetch(`${this.rootConfig.ipfs.url}/add`, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        console.error(`[message-board] IPFS upload failed with status: ${response.status}`);
        return null;
      }

      const result = await response.json();
      const ipfsHash = result.Hash;
      console.log(`[message-board] Uploaded to IPFS: ${ipfsHash}`);

      return {
        hash: ipfsHash,
        url: `${this.rootConfig.ipfs.gateway}/ipfs/${ipfsHash}`
      };
    } catch (error) {
      console.error('[message-board] IPFS upload error:', error);
      return null;
    }
  }

  /**
   * Add post to batch chain
   * Returns the chained post data
   */
  async addPostToBatch(post, userSignature, domain) {
    const state = this.getDomainState(domain);

    // Create hash chain entry
    const hash = this.hashPost(post, state.lastHash);
    const chainedPost = {
      ...post,
      hash: hash,
      previousHash: state.lastHash,
      chainIndex: state.postChain.length,
      userSignature: userSignature
    };

    // Sign with server
    const serverSig = await this.signPostAsServer(chainedPost);

    // Create Data Wallet structure
    const dataWallet = {
      data: {
        id: post.id,
        text: post.text,
        image: post.image,
        timestamp: post.timestamp
      },
      author: {
        address: post.author,
        name: post.authorName,
        signature: userSignature || 'client-side-signature-pending'
      },
      server: {
        address: this.epistery?.domain?.wallet?.address || 'server-wallet-pending',
        domain: this.epistery?.domainName || 'localhost',
        signature: serverSig
      },
      chain: {
        hash: hash,
        previousHash: state.lastHash,
        index: state.postChain.length
      },
      timestamp: new Date().toISOString()
    };

    // Upload to IPFS
    const ipfsResult = await this.uploadToIPFS(dataWallet);
    if (ipfsResult) {
      dataWallet.ipfsHash = ipfsResult.hash;
      dataWallet.ipfsUrl = ipfsResult.url;
      chainedPost.ipfsHash = ipfsResult.hash;
      chainedPost.ipfsUrl = ipfsResult.url;
    }

    // Add to chain
    state.postChain.push(chainedPost);
    state.lastHash = hash;

    // Save batch state
    this.saveBatchState(domain);

    const config = new Config();
    config.setPath(domain);
    const batchThreshold = config.data.messageBoard.batchThreshold;

    console.log(`[message-board] Post added to batch chain for ${domain}. Total: ${state.postChain.length}/${batchThreshold}`);

    // Check if we need to flush to blockchain
    if (state.postChain.length >= batchThreshold) {
      await this.flushBatch(domain);
    }

    return chainedPost;
  }

  /**
   * Flush batched posts to blockchain
   */
  async flushBatch(domain) {
    const state = this.getDomainState(domain);

    if (state.postChain.length === 0) {
      console.log(`[message-board] No posts to flush for ${domain}`);
      return;
    }

    console.log(`[message-board] Flushing ${state.postChain.length} posts to blockchain for ${domain}...`);

    try {
      // Create batch summary
      const batchSummary = {
        posts: state.postChain.map(p => ({
          id: p.id,
          hash: p.hash,
          ipfsHash: p.ipfsHash,
          author: p.author,
          timestamp: p.timestamp
        })),
        chainRoot: state.lastHash,
        count: state.postChain.length,
        timestamp: Date.now()
      };

      // Upload batch summary to IPFS
      const batchIpfs = await this.uploadToIPFS(batchSummary);

      if (batchIpfs) {
        console.log(`[message-board] Batch summary uploaded to IPFS: ${batchIpfs.hash}`);

        // TODO: Write batch IPFS hash to blockchain
        // await this.epistery.writeToContract(batchIpfs.hash);
        console.log('[message-board] TODO: Write batch to blockchain (gas payment)');
      }

      // Clear batch
      state.postChain = [];
      state.lastHash = crypto.createHash('sha256').update(state.lastHash).digest('hex');
      this.saveBatchState(domain);

      console.log(`[message-board] Batch flush complete for ${domain}`);
    } catch (error) {
      console.error(`[message-board] Batch flush error for ${domain}:`, error);
    }
  }

  /**
   * Save batch state to file
   */
  saveBatchState(domain) {
    const state = this.getDomainState(domain);
    const config = new Config();
    config.setPath(domain);

    const batchData = {
      chain: state.postChain,
      lastHash: state.lastHash,
      lastFlush: Date.now()
    };
    config.writeFile('message-board-batch.json', JSON.stringify(batchData, null, 2));
  }

  /**
   * Cleanup on shutdown (optional)
   */
  async cleanup() {
    // Flush any pending posts for all domains
    for (const [domain, state] of this.domainStates.entries()) {
      if (state.postChain.length > 0) {
        console.log(`[message-board] Flushing pending posts for ${domain} on shutdown...`);
        await this.flushBatch(domain);
      }
    }

    if (this.wss) {
      this.wss.close();
    }
    console.log('[message-board] Agent cleanup');
  }

  /**
   * Load sidebar links from Config storage for a specific domain
   */
  loadSidebarLinks(domain) {
    try {
      const config = new Config();
      config.setPath(domain);
      const linksData = config.readFile('sidebar-links.json');
      return JSON.parse(linksData.toString());
    } catch (error) {
      // No links file yet, return empty array
      return [];
    }
  }

  /**
   * Save sidebar links to Config storage for a specific domain
   */
  saveSidebarLinks(domain, links) {
    const config = new Config();
    config.setPath(domain);
    config.save(); // Ensure directory exists
    config.writeFile('sidebar-links.json', JSON.stringify(links, null, 2));
  }
}
