import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import { Config } from 'epistery';
import crypto from 'crypto';
import https from "https";
import http from "http";
import StorageFactory from '../epistery-host/utils/storage/StorageFactory.mjs';

const require = createRequire(import.meta.url);
const ethers = require('ethers');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Message Board Agent
 *
 * Provides a discussion board / posting wall for epistery hosts.
 * Access control integration and notabot scores.
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

    // Storage backends (per domain)
    this.storageBackends = new Map();
  }

  /**
   * Get or create storage backend for a domain
   */
  async getStorage(domain) {
    if (!this.storageBackends.has(domain)) {
      const storage = await StorageFactory.create(null, domain, 'message-board');
      this.storageBackends.set(domain, storage);
    }
    return this.storageBackends.get(domain);
  }

  /**
   * Get DomainAgent contract instance for ACL operations
   * Demonstrates new contract architecture (not backwards-compatible methods)
   */
  async getContract(domain) {
    const config = new Config();
    config.setPath(domain);

    const contractAddress = config.data?.contract_address;
    if (!contractAddress) {
      throw new Error('Contract not deployed for domain');
    }

    const serverWallet = config.data?.wallet;
    const provider = config.data?.provider;

    if (!serverWallet || !provider) {
      throw new Error('Server wallet or provider not configured');
    }

    // Load DomainAgent artifact from epistery-host
    const DomainAgentArtifact = JSON.parse(
      readFileSync(path.join(__dirname, '../epistery-host/artifacts/contracts/DomainAgent.sol/DomainAgent.json'), 'utf8')
    );

    const ethersProvider = new ethers.providers.JsonRpcProvider(provider.rpc);
    const wallet = ethers.Wallet.fromMnemonic(serverWallet.mnemonic).connect(ethersProvider);

    return new ethers.Contract(contractAddress, DomainAgentArtifact.abi, wallet);
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
   * Get permissions using DomainAgent contract
   * Demonstrates new contract architecture with isInACL()
   */
  async getPermissions(client, req) {
    const result = {address:client.address,admin:false,edit:false,read:true};
    if (client && req.domain) {
      try {
        result.admin = await this.isInACL(client.address, 'epistery::admin', req.domain);
        result.edit = result.admin || await this.isInACL(client.address, 'epistery::editor', req.domain);
      } catch (error) {
        console.error('[message-board] Permission check error:', error);
      }
      return result;
    }

    console.log('[wiki] Write denied: not on epistery::admin or epistery::editor');
    return false;
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
    router.use('/client', express.static(path.join(__dirname, 'client')));

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

    // Serve board page (main UI) - routes to appropriate view based on config
    router.get('/board', (req, res) => {
      const viewMode = req.boardConfig.data.messageBoard.viewMode || 'board';
      const viewPath = path.join(__dirname, `client/${viewMode}.html`);

      if (!existsSync(viewPath)) {
        console.error(`[message-board] View file not found: ${viewPath}, falling back to board.html`);
        const boardPath = path.join(__dirname, 'client/board.html');
        return res.sendFile(boardPath);
      }

      res.sendFile(viewPath);
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

    // Client permissions
    router.get('/api/permissions', async (req, res) => {
      const permissions = await this.getPermissions(req.episteryClient, req);
      res.json(permissions);
    })

    // Get sidebar links
    router.get('/links', (req, res) => {
      const links = this.loadSidebarLinks(req.domain);
      res.json(links);
    });

    // Add sidebar link (requires admin permission)
    router.post('/links', async (req, res) => {
      try {
        const permission = await this.checkAdminPermission(req);
        if (!permission.allowed) {
          return res.status(403).json({ error: 'Only admins can manage links' });
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

    // Delete sidebar link (requires admin permission)
    router.delete('/links/:index', async (req, res) => {
      try {
        const permission = await this.checkAdminPermission(req);
        if (!permission.allowed) {
          return res.status(403).json({ error: 'Only admins can manage links' });
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

    // Get channels (filtered by user's access)
    router.get('/api/channels', async (req, res) => {
      try {
        let channels = req.boardConfig.data.messageBoard.channels || [];

        // Fix: parse any channels that were accidentally saved as strings
        channels = channels.map(ch => {
          if (typeof ch === 'string') {
            try {
              return JSON.parse(ch);
            } catch (e) {
              console.error('[message-board] Failed to parse channel string:', ch);
              return null;
            }
          }
          return ch;
        }).filter(ch => ch !== null);

        // Always include "General" pseudo-channel for posts without a channel
        const accessibleChannels = [{ name: 'general', list: null, isPseudo: true }];

        // Filter channels based on user's access
        if (req.episteryClient && req.episteryClient.address) {
          // Check user's access level to message-board
          const access = await req.domainAcl.checkAgentAccess(
            '@epistery/message-board',
            req.episteryClient.address,
            req.hostname
          );

          // Admins (level 3) see all channels
          if (access.level >= 3) {
            accessibleChannels.push(...channels);
          } else {
            // Non-admins see only channels they have access to
            for (const channel of channels) {
              if (!channel.list) {
                // No ACL specified - use agent access level
                if (access.level >= 1) { // Level 1 (reader) or higher
                  accessibleChannels.push(channel);
                }
              } else {
                // Check specific list access
                const isInList = await req.domainAcl.chain.contract.isInACL(
                  channel.list,
                  req.episteryClient.address
                );
                if (isInList) {
                  accessibleChannels.push(channel);
                }
              }
            }
          }
        } else {
          // No authenticated client - only show channels with no ACL
          for (const channel of channels) {
            if (!channel.list) {
              accessibleChannels.push(channel);
            }
          }
        }

        res.json(accessibleChannels);
      } catch (error) {
        console.error('[message-board] Get channels error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Add channel (admin only)
    router.post('/api/channels', async (req, res) => {
      try {
        const permission = await this.checkAdminPermission(req);
        if (!permission.allowed) {
          return res.status(403).json({ error: 'Only admins can add channels' });
        }

        const { name, list } = req.body;
        if (!name || !/^[a-z0-9-]+$/.test(name)) {
          return res.status(400).json({ error: 'Invalid channel name. Use lowercase letters, numbers, and hyphens only.' });
        }

        // Prevent creating "general" as it's reserved for the pseudo-channel
        if (name === 'general') {
          return res.status(400).json({ error: 'Channel name "general" is reserved for uncategorized posts.' });
        }

        if (!req.boardConfig.data.messageBoard.channels) {
          req.boardConfig.data.messageBoard.channels = [];
        }

        // Check if channel already exists (handle string channels)
        const existingChannel = req.boardConfig.data.messageBoard.channels.find(c => {
          const ch = typeof c === 'string' ? JSON.parse(c) : c;
          return ch.name === name;
        });
        if (existingChannel) {
          return res.status(400).json({ error: 'Channel already exists' });
        }

        req.boardConfig.data.messageBoard.channels.push({
          name,
          list: list || null
        });
        req.boardConfig.save();

        res.json({ success: true, channel: { name, list: list || null } });
      } catch (error) {
        console.error('[message-board] Add channel error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Delete channel (admin only)
    router.delete('/api/channels/:name', async (req, res) => {
      try {
        const permission = await this.checkAdminPermission(req);
        if (!permission.allowed) {
          return res.status(403).json({ error: 'Only admins can delete channels' });
        }

        const { name } = req.params;
        if (!req.boardConfig.data.messageBoard.channels) {
          return res.status(404).json({ error: 'Channel not found' });
        }

        // Parse string channels and find matching one
        const channels = req.boardConfig.data.messageBoard.channels;
        const index = channels.findIndex(c => {
          const channel = typeof c === 'string' ? JSON.parse(c) : c;
          return channel.name === name;
        });

        if (index === -1) {
          return res.status(404).json({ error: 'Channel not found' });
        }

        req.boardConfig.data.messageBoard.channels.splice(index, 1);
        req.boardConfig.save();

        res.json({ success: true });
      } catch (error) {
        console.error('[message-board] Delete channel error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Get view mode
    router.get('/api/config/view-mode', (req, res) => {
      const viewMode = req.boardConfig.data.messageBoard.viewMode || 'board';
      res.json({ viewMode });
    });

    // Update view mode (requires admin permission)
    router.put('/api/config/view-mode', async (req, res) => {
      try {
        const permission = await this.checkAdminPermission(req);
        if (!permission.allowed) {
          return res.status(403).json({ error: 'Only admins can change view mode' });
        }

        const { viewMode } = req.body;
        if (!viewMode || !['board', 'chat'].includes(viewMode)) {
          return res.status(400).json({ error: 'Invalid view mode. Must be "board" or "chat"' });
        }

        req.boardConfig.data.messageBoard.viewMode = viewMode;
        req.boardConfig.save();

        res.json({ success: true, viewMode });
      } catch (error) {
        console.error('[message-board] Update view mode error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Update image settings (requires admin permission)
    router.patch('/api/settings/image', async (req, res) => {
      try {
        // Check admin permission
        const permission = await this.checkAdminPermission(req);
        if (!permission.allowed) {
          return res.status(403).json({ error: 'Only admins can update settings' });
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

    // Get posts filtered by channel access — server enforces ACL, not client
    router.get('/api/posts', async (req, res) => {
      try {
        const data = await this.readData(req.domain);
        const { channel } = req.query;

        // Determine which channels this user may see
        const accessible = await this.getAccessibleChannelNames(req);

        // Strip posts from channels the user cannot access
        let posts = data.posts.filter(post => accessible.has(post.channel || 'general'));

        // Further narrow by requested channel
        if (channel) {
          if (!accessible.has(channel)) {
            return res.status(403).json({ error: 'Access denied' });
          }
          if (channel === 'general') {
            posts = posts.filter(post => !post.channel || post.channel === 'general');
          } else {
            posts = posts.filter(post => post.channel === channel);
          }
        }

        res.json(posts);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Create new post (requires auth + permission)
    router.post('/api/posts', async (req, res) => {
      try {
        console.log('[message-board] Received post request');

        const { text, image, channel } = req.body;

        //TODO: Text is not required if an image is attached
        if (!text || text.trim().length === 0) {
          return res.status(400).json({ error: 'Text is required' });
        }

        // Validate channel if provided
        if (channel && channel !== 'general') {
          const channels = req.boardConfig.data.messageBoard.channels || [];
          // Parse string channels and check if it exists
          const channelExists = channels.find(c => {
            const ch = typeof c === 'string' ? JSON.parse(c) : c;
            return ch.name === channel;
          });
          if (!channelExists) {
            return res.status(400).json({ error: 'Invalid channel' });
          }
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

        const data = await this.readData(req.domain);
        const post = {
          id: data.nextId++,
          text: text.trim(),
          image: image || null,
          author: permission.user.address,
          authorName: permission.user.name || null,
          timestamp: Date.now(),
          comments: [],
          channel: channel || null
        };

        // Add to local storage
        data.posts.unshift(post);

        // Write individual post file
        await this.writePost(req.domain, post);

        // Update index
        await this.writeData(req.domain, data);

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

        const data = await this.readData(req.domain);
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

        // Write updated post with new comment
        await this.writePost(req.domain, post);
        await this.writeData(req.domain, data);

        this.broadcast({ type: 'new-comment', postId, comment }, req.domain);
        res.json(comment);
      } catch (error) {
        console.error('[message-board] Comment error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Delete post (author or admin)
    router.delete('/api/posts/:id', async (req, res) => {
      try {
        const postId = parseInt(req.params.id);

        if (!req.episteryClient) {
          return res.status(401).json({ error: 'Authentication required' });
        }

        const userAddress = req.episteryClient.address;
        const data = await this.readData(req.domain);
        const post = data.posts.find(p => p.id === postId);

        if (!post) {
          return res.status(404).json({ error: 'Post not found' });
        }

        // Check if user can delete this post
        // Allow: post author OR admin
        const isAuthor = post.author.toLowerCase() === userAddress.toLowerCase();
        const adminPermission = await this.checkAdminPermission(req);
        const canDelete = isAuthor || adminPermission.allowed;

        if (!canDelete) {
          return res.status(403).json({
            error: 'You can only delete your own posts unless you are an admin'
          });
        }

        // Delete the post from storage
        await this.deletePost(req.domain, postId);

        // Remove from index
        const index = data.posts.findIndex(p => p.id === postId);
        data.posts.splice(index, 1);
        await this.writeData(req.domain, data);

        this.broadcast({ type: 'delete-post', postId }, req.domain);
        res.json({ success: true });
      } catch (error) {
        console.error('[message-board] Delete error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Edit post (author only)
    router.patch('/api/posts/:id', async (req, res) => {
      try {
        const postId = parseInt(req.params.id);
        const { text } = req.body;

        if (!text || text.trim().length === 0) {
          return res.status(400).json({ error: 'Text is required' });
        }

        if (!req.episteryClient) {
          return res.status(401).json({ error: 'Authentication required' });
        }

        const userAddress = req.episteryClient.address;
        const data = await this.readData(req.domain);
        const post = data.posts.find(p => p.id === postId);

        if (!post) {
          return res.status(404).json({ error: 'Post not found' });
        }

        // Only the author can edit their post
        if (post.author.toLowerCase() !== userAddress.toLowerCase()) {
          return res.status(403).json({
            error: 'Only the author can edit this post'
          });
        }

        // Update the post
        post.text = text.trim();
        post.editedAt = Date.now();

        // Write updated post
        await this.writePost(req.domain, post);
        await this.writeData(req.domain, data);

        this.broadcast({ type: 'edit-post', post }, req.domain);
        res.json(post);
      } catch (error) {
        console.error('[message-board] Edit error:', error);
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
        const permission = await this.checkAdminPermission(req);
        if (!permission.allowed) {
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
        const permission = await this.checkAdminPermission(req);
        if (!permission.allowed) {
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
    router.get('/status', async (req, res) => {
      const data = await this.readData(req.domain);
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
   * Uses agent-specific ACL configuration
   */
  async checkPostingPermission(req) {
    // Check for authenticated client from epistery-host middleware
    if (!req.episteryClient) {
      console.log('[message-board] No authenticated client');
      return { allowed: false, reason: 'Authentication required' };
    }

    const address = req.episteryClient.address;
    console.log(`[message-board] Checking permissions for ${address}`);

    try {
      const access = await req.domainAcl.checkAgentAccess('@epistery/message-board', address, req.hostname);
      console.log(`[message-board] Access level for ${address}: ${access.level}`);

      // Level 2 (editor) or higher can post
      if (access.level >= 2) {
        // Get user's name from ACL if available
        console.log('[message-board] Fetching user name for:', address);
        const userName = await this.getUserName(req, address);
        console.log('[message-board] Got user name:', userName);

        return {
          allowed: true,
          user: { address, name: userName },
          level: access.level
        };
      }

      return {
        allowed: false,
        reason: 'You need editor privileges to post. Request access in the sidebar.'
      };
    } catch (error) {
      console.error('[message-board] Permission check failed:', error);
      return {
        allowed: false,
        reason: 'Permission check failed'
      };
    }
  }

  /**
   * Get user's name from ACL lists
   */
  async getUserName(req, address) {
    try {
      console.log('[message-board] getUserName called for:', address);

      // Get all lists the user is a member of
      const membershipEntries = await req.domainAcl.chain.contract.getListsForMember(address);
      console.log('[message-board] User is member of lists:', membershipEntries.map(e => e.listName));

      // Check each list for the user's ACL entry with a name
      for (const entry of membershipEntries) {
        console.log('[message-board] Checking list:', entry.listName);

        // Get all ACL entries for this list
        const aclEntries = await req.domainAcl.chain.contract.getACL(entry.listName);
        console.log('[message-board] ACL entries for', entry.listName, ':', aclEntries.length);

        // Find the entry for this address
        const userEntry = aclEntries.find(e =>
          e.addr.toLowerCase() === address.toLowerCase()
        );
        console.log('[message-board] Found user entry:', userEntry);

        if (userEntry && userEntry.name && userEntry.name.trim() !== '') {
          console.log('[message-board] Returning name:', userEntry.name);
          return userEntry.name;
        }
      }

      console.log('[message-board] No name found, returning null');
      return null;
    } catch (error) {
      console.error('[message-board] Failed to get user name:', error);
      return null;
    }
  }

  /**
   * Check if user has admin permission
   */
  // Returns a Set of channel names accessible to the requesting user.
  // Always includes 'general'. Unauthenticated users only see channels without an ACL.
  async getAccessibleChannelNames(req) {
    let channels = req.boardConfig.data.messageBoard.channels || [];
    channels = channels.map(ch => typeof ch === 'string' ? JSON.parse(ch) : ch).filter(Boolean);

    const accessible = new Set(['general']);

    if (req.episteryClient && req.episteryClient.address) {
      const access = await req.domainAcl.checkAgentAccess(
        '@epistery/message-board', req.episteryClient.address, req.hostname
      );
      if (access.level >= 3) {
        channels.forEach(ch => accessible.add(ch.name));
      } else {
        for (const ch of channels) {
          if (!ch.list) {
            if (access.level >= 1) accessible.add(ch.name);
          } else {
            const isInList = await req.domainAcl.chain.contract.isInACL(ch.list, req.episteryClient.address);
            if (isInList) accessible.add(ch.name);
          }
        }
      }
    } else {
      // Unauthenticated: only channels with no ACL
      channels.filter(ch => !ch.list).forEach(ch => accessible.add(ch.name));
    }

    return accessible;
  }

  async checkAdminPermission(req) {
    if (!req.episteryClient) {
      return { allowed: false, reason: 'Authentication required' };
    }

    const address = req.episteryClient.address;

    try {
      const access = await req.domainAcl.checkAgentAccess('@epistery/message-board', address, req.hostname);

      // Level 3 (admin) required
      if (access.level >= 3) {
        return { allowed: true, user: { address }, level: access.level };
      }

      return { allowed: false, reason: 'Admin permission required' };
    } catch (error) {
      console.error('[message-board] Admin permission check failed:', error);
      return { allowed: false, reason: 'Permission check failed' };
    }
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
   * Check if address is in ACL using DomainAgent contract
   * Demonstrates new contract architecture with isInACL()
   */
  async isInACL(address, listName, domain) {
    try {
      const contract = await this.getContract(domain);
      return await contract.isInACL(listName, address);
    } catch (error) {
      console.error(`[message-board] ACL check error for ${listName}:`, error);
      return false;
    }
  }

  /**
   * Case-insensitive ACL check (alias for isInACL for backwards compatibility)
   */
  async isListedCaseInsensitive(address, listName, domain) {
    return this.isInACL(address, listName, domain);
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
  /**
   * Read posts data - loads index and returns posts array with metadata
   */
  async readData(domain) {
    const storage = await this.getStorage(domain);

    try {
      // Try to read the index file
      const indexData = await storage.readFile('posts/index.json');
      const index = JSON.parse(indexData.toString());

      // Load all posts in parallel
      const postPromises = index.posts.map(async (meta) => {
        try {
          const postData = await storage.readFile(`posts/${meta.id}.json`);
          return JSON.parse(postData.toString());
        } catch (error) {
          console.error(`[message-board] Failed to load post ${meta.id}:`, error.message);
          return null;
        }
      });

      const posts = (await Promise.all(postPromises)).filter(p => p !== null);

      return {
        posts,
        nextId: index.nextId || (Math.max(...posts.map(p => p.id), 0) + 1)
      };
    } catch (error) {
      // No index exists yet - try legacy migration
      return await this.migrateLegacyData(domain, storage);
    }
  }

  /**
   * Migrate legacy JSON file to new storage structure
   */
  async migrateLegacyData(domain, storage) {
    const config = new Config();
    config.setPath(domain);

    try {
      const legacyData = config.readFile('message-board-posts.json');
      const data = JSON.parse(legacyData.toString());

      console.log(`[message-board] Migrating ${data.posts.length} posts to storage...`);

      // Write each post as separate file
      await Promise.all(data.posts.map(post =>
        storage.writeFile(`posts/${post.id}.json`, JSON.stringify(post, null, 2))
      ));

      // Write index
      const index = {
        nextId: data.nextId,
        posts: data.posts.map(p => ({
          id: p.id,
          timestamp: p.timestamp,
          author: p.author,
          channel: p.channel || null
        }))
      };
      await storage.writeFile('posts/index.json', JSON.stringify(index, null, 2));

      console.log(`[message-board] Migration complete`);
      return data;
    } catch (error) {
      // No legacy data either - start fresh
      if (error.code === 'ENOENT' || error.message.includes('not found')) {
        return { posts: [], nextId: 1 };
      }
      throw error;
    }
  }

  /**
   * Write post data - stores individual post and updates index
   */
  async writeData(domain, data) {
    const storage = await this.getStorage(domain);

    // Build index from current posts
    const index = {
      nextId: data.nextId,
      posts: data.posts.map(p => ({
        id: p.id,
        timestamp: p.timestamp,
        author: p.author,
        channel: p.channel || null
      }))
    };

    // Write index
    await storage.writeFile('posts/index.json', JSON.stringify(index, null, 2));

    // Note: Individual posts are written via writePost()
  }

  /**
   * Write a single post to storage
   */
  async writePost(domain, post) {
    const storage = await this.getStorage(domain);
    await storage.writeFile(`posts/${post.id}.json`, JSON.stringify(post, null, 2));
  }

  /**
   * Delete a single post from storage
   */
  async deletePost(domain, postId) {
    const storage = await this.getStorage(domain);
    await storage.deleteFile(`posts/${postId}.json`);
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
