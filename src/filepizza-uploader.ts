import Peer, { DataConnection } from 'peerjs'
import { EventEmitter } from './event-emitter'
import { FileInfo, ProgressInfo, ConnectionInfo, ConnectionStatus, MessageType } from './types';

/**
 * FilePizza Uploader - connects to the FilePizza server and uploads files
 */
export class FilePizzaUploader extends EventEmitter {
  private peer?: Peer;
  private connections: Map<string, any> = new Map();
  private connectionInfoMap = new Map<string, any>();
  private files: File[] = [];
  private password?: string;
  private filePizzaServerUrl: string;
  private channelInfo?: { longSlug: string; shortSlug: string; secret?: string };
  private sharedSlug?: string;
  private iceServers?: RTCIceServer[];
  private renewalTimer?: NodeJS.Timeout;

  /**
   * Create a new FilePizza uploader
   * @param options Configuration options
   */
  constructor(options: {
    filePizzaServerUrl?: string;
    password?: string;
    sharedSlug?: string;
  } = {}) {
    super();
    this.filePizzaServerUrl = options.filePizzaServerUrl || 'http://localhost:8081';
    this.password = options.password;
    this.sharedSlug = options.sharedSlug;
  }

  /**
   * Initialize the uploader
   */
  async initialize(): Promise<void> {
    if (this.peer) {
      return;
    }

    // Get ICE servers
    await this.getIceServers();

    // Initialize PeerJS
    this.peer = new Peer({
      config: {
        iceServers: this.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }],
      },
      debug: 2,
    });

    // Wait for peer to be ready
    if (!this.peer.id) {
      await new Promise<void>((resolve) => {
        const onOpen = () => {
          this.peer?.off('open', onOpen);
          resolve();
        };
        this.peer?.on('open', onOpen);
      });
    }

    // Set up connection handling
    this.peer.on('connection', this.handleConnection.bind(this));

    // Create channel
    if (this.peer.id) {
      await this.createChannel(this.peer.id, this.sharedSlug || undefined);
      this.startChannelRenewal();
    }
  }

  setPassword(password: string): void {
    this.password = password
  }

  /**
   * Set files to be shared
   */
  setFiles(files: File[]): void {
    this.files = Array.from(files);

    // Update file info for existing connections
    if (this.files.length > 0) {
      for (const [_, connection] of this.connections.entries()) {
        if (connection.status === ConnectionStatus.Ready) {
          connection.dataConnection.send({
            type: MessageType.Info,
            files: this.getFileInfo(),
          });
        }
      }
    }
  }

  /**
   * Get shareable links for the current channel
   */
  getShareableLinks(): { long: string; short: string } | null {
    if (!this.channelInfo) {
      return null;
    }

    return {
      long: `${this.filePizzaServerUrl}/download/${this.channelInfo.longSlug}`,
      short: `${this.filePizzaServerUrl}/download/${this.channelInfo.shortSlug}`,
    };
  }

  /**
   * Stop sharing and clean up
   */
  async stop(): Promise<void> {
    // Stop channel renewal
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = undefined;
    }

    // Destroy channel if we have one
    if (this.channelInfo) {
      try {
        await this.destroyChannel(this.channelInfo.shortSlug);
      } catch (error) {
        console.error('Error destroying channel:', error);
      }
    }

    // Close all connections
    for (const [_, connection] of this.connections.entries()) {
      if (connection.dataConnection.open) {
        connection.dataConnection.close();
      }
    }

    // Clear connections
    this.connections.clear();

    // Destroy peer
    if (this.peer) {
      this.peer.destroy();
      this.peer = undefined;
    }

    // Reset state
    this.channelInfo = undefined;
  }

  /**
   * Get ICE servers from the FilePizza server
   */
  private async getIceServers(): Promise<RTCIceServer[]> {
    try {
      const response = await fetch(`${this.filePizzaServerUrl}/api/ice`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`Failed to get ICE servers: ${response.status}`);
      }

      const data = await response.json();
      this.iceServers = data.iceServers;
      return data.iceServers;
    } catch (error) {
      console.error('Error getting ICE servers:', error);
      return [{ urls: 'stun:stun.l.google.com:19302' }];
    }
  }

  /**
   * Create a new channel on the FilePizza server
   */
  private async createChannel(uploaderPeerID: string, sharedSlug?: string): Promise<void> {
    try {
      const payload: { uploaderPeerID: string; sharedSlug?: string } = { uploaderPeerID };

      if (sharedSlug) {
        payload.sharedSlug = sharedSlug;
      }

      const response = await fetch(`${this.filePizzaServerUrl}/api/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Failed to create channel: ${response.status}`);
      }

      this.channelInfo = await response.json();
    } catch (error) {
      console.error('Error creating channel:', error);
      throw error;
    }
  }

  /**
   * Renew the channel to keep it alive
   */
  private async renewChannel(): Promise<void> {
    if (!this.channelInfo || !this.channelInfo.secret) {
      return;
    }

    try {
      const response = await fetch(`${this.filePizzaServerUrl}/api/renew`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: this.channelInfo.shortSlug,
          secret: this.channelInfo.secret,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to renew channel: ${response.status}`);
      }
    } catch (error) {
      console.error('Error renewing channel:', error);
    }
  }

  /**
   * Destroy a channel
   */
  private async destroyChannel(slug: string): Promise<void> {
    try {
      const response = await fetch(`${this.filePizzaServerUrl}/api/destroy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });

      if (!response.ok) {
        throw new Error(`Failed to destroy channel: ${response.status}`);
      }
    } catch (error) {
      console.error('Error destroying channel:', error);
    }
  }

  /**
   * Start channel renewal
   */
  private startChannelRenewal(): void {
    if (!this.channelInfo || !this.channelInfo.secret) {
      return;
    }

    // Renew every 30 minutes
    const renewalInterval = 30 * 60 * 1000;

    this.renewalTimer = setInterval(() => {
      this.renewChannel();
    }, renewalInterval);
  }

  /**
   * Handle new connection
   */
  private handleConnection(conn: DataConnection): void {
    // Ignore connections for reporting (handled separately)
    if (conn.metadata?.type === 'report') {
      this.emit('report', conn.peer);
      return;
    }

    console.log(`[FilePizzaUploader] New connection from ${conn.peer}`);

    const connectionContext = {
      status: ConnectionStatus.Pending,
      dataConnection: conn,
      fileIndex: 0,
      filesInfo: this.getFileInfo(),
      totalFiles: this.files.length,
      bytesTransferred: 0,
      totalBytes: this.getTotalBytes(),
      currentFileProgress: 0,
    };

    this.connections.set(conn.peer, connectionContext);

    // Set up event handlers
    conn.on('data', (data) => this.handleData(conn, data));
    conn.on('close', () => this.handleClose(conn));
    conn.on('error', (error) => this.handleError(conn, error));

    // Emit connection event
    this.emit('connection', this.getConnectionInfo(conn.peer));
  }

  /**
   * Handle data messages from connection
   */
  private handleData(conn: DataConnection, data: unknown): void {
    const context = this.connections.get(conn.peer);
    if (!context) return;

    try {
      // WebRTC messages follow a specific format with a type field
      const message = data as any;

      switch (message.type) {
        case MessageType.RequestInfo:
          this.handleRequestInfo(conn, context, message);
          break;

        case MessageType.UsePassword:
          this.handleUsePassword(conn, context, message);
          break;

        case MessageType.Start:
          this.handleStart(conn, context, message);
          break;

        case MessageType.Pause:
          this.handlePause(conn, context);
          break;

        case MessageType.Resume:
          this.handleResume(conn, context, message);
          break;

        case MessageType.Done:
          this.handleDone(conn, context);
          break;
      }
    } catch (error) {
      console.error('[FilePizzaUploader] Error handling message:', error);
      conn.send({
        type: MessageType.Error,
        error: 'Failed to process message',
      });
    }
  }

  /**
   * Handle connection close
   */
  private handleClose(conn: DataConnection): void {
    const context = this.connections.get(conn.peer);
    if (!context) return;

    // Update connection status
    context.status = ConnectionStatus.Closed;

    // Emit connection closed event
    this.emit('disconnection', conn.peer);

    // Remove connection
    this.connections.delete(conn.peer);
  }

  /**
   * Handle connection error
   */
  private handleError(conn: DataConnection, error: Error): void {
    const context = this.connections.get(conn.peer);
    if (!context) return;

    // Update connection status
    context.status = ConnectionStatus.Error;

    // Emit error event
    this.emit('error', { connectionId: conn.peer, error });

    // Close connection
    if (conn.open) {
      conn.close();
    }
  }

  /**
   * Handle RequestInfo message
   */
  private handleRequestInfo(conn: DataConnection, context: any, message: any): void {
    // Store browser info in connection metadata
    this.connectionInfoMap.set(conn.connectionId, {
      browserName: message.browserName,
      browserVersion: message.browserVersion,
      osName: message.osName,
      osVersion: message.osVersion,
      mobileVendor: message.mobileVendor,
      mobileModel: message.mobileModel,
    });

    // Check if password is required
    if (this.password) {
      conn.send({
        type: MessageType.PasswordRequired,
      });

      context.status = ConnectionStatus.Authenticating;
    } else {
      // Send file info
      conn.send({
        type: MessageType.Info,
        files: context.filesInfo,
      });

      context.status = ConnectionStatus.Ready;
    }

    // Emit connection update
    this.emit('connectionUpdate', this.getConnectionInfo(conn.peer));
  }

  /**
   * Handle UsePassword message
   */
  private handleUsePassword(conn: DataConnection, context: any, message: any): void {
    // Check password
    if (message.password === this.password) {
      // Password correct, send file info
      conn.send({
        type: MessageType.Info,
        files: context.filesInfo,
      });

      context.status = ConnectionStatus.Ready;
    } else {
      // Password incorrect
      conn.send({
        type: MessageType.PasswordRequired,
        errorMessage: 'Incorrect password',
      });

      context.status = ConnectionStatus.InvalidPassword;
    }

    // Emit connection update
    this.emit('connectionUpdate', this.getConnectionInfo(conn.peer));
  }

  /**
   * Handle Start message
   */
  private handleStart(conn: DataConnection, context: any, message: any): void {
    // Find the requested file
    const fileName = message.fileName;
    const offset = message.offset;

    const file = this.findFile(fileName);
    if (!file) {
      conn.send({
        type: MessageType.Error,
        error: `File not found: ${fileName}`,
      });
      return;
    }

    // Update connection status
    context.status = ConnectionStatus.Uploading;
    context.uploadingFileName = fileName;
    context.uploadingOffset = offset;

    // Emit status update
    this.emit('connectionUpdate', this.getConnectionInfo(conn.peer));

    // Begin sending file chunks
    this.sendFileChunks(conn, context, file, offset);
  }

  /**
   * Handle Pause message
   */
  private handlePause(conn: DataConnection, context: any): void {
    context.status = ConnectionStatus.Paused;
    this.emit('connectionUpdate', this.getConnectionInfo(conn.peer));
  }

  /**
   * Handle Resume message
   */
  private handleResume(conn: DataConnection, context: any, message: any): void {
    const fileName = message.fileName;
    const offset = message.offset;

    const file = this.findFile(fileName);
    if (!file) {
      conn.send({
        type: MessageType.Error,
        error: `File not found: ${fileName}`,
      });
      return;
    }

    context.status = ConnectionStatus.Uploading;
    context.uploadingFileName = fileName;
    context.uploadingOffset = offset;

    this.emit('connectionUpdate', this.getConnectionInfo(conn.peer));

    this.sendFileChunks(conn, context, file, offset);
  }

  /**
   * Handle Done message
   */
  private handleDone(conn: DataConnection, context: any): void {
    context.status = ConnectionStatus.Done;
    this.emit('connectionUpdate', this.getConnectionInfo(conn.peer));
    conn.close();
  }

  /**
   * Send file chunks to the downloader
   */
  private sendFileChunks(
    conn: DataConnection,
    context: any,
    file: File,
    startOffset: number
  ): void {
    let offset = startOffset;
    const CHUNK_SIZE = 256 * 1024; // 256 KB

    const sendNextChunk = () => {
      // Check if connection is still open and in uploading state
      if (!conn.open || context.status !== ConnectionStatus.Uploading) {
        return;
      }

      const end = Math.min(file.size, offset + CHUNK_SIZE);
      const chunkSize = end - offset;
      const final = end >= file.size;

      // Create chunk
      const chunk = file.slice(offset, end);

      // Send chunk
      conn.send({
        type: MessageType.Chunk,
        fileName: file.name,
        offset,
        bytes: chunk,
        final,
      });

      // Update progress
      offset = end;
      context.uploadingOffset = offset;
      context.currentFileProgress = offset / file.size;
      context.bytesTransferred += chunkSize;

      // Emit progress update
      this.emit('progress', this.getProgressInfo(conn.peer));

      // If this was the final chunk
      if (final) {
        if (context.fileIndex < context.totalFiles - 1) {
          // Move to next file
          context.fileIndex++;
          context.currentFileProgress = 0;
          context.status = ConnectionStatus.Ready;

          // Emit update
          this.emit('connectionUpdate', this.getConnectionInfo(conn.peer));
        } else {
          // All files completed
          context.fileIndex = context.totalFiles;
          context.currentFileProgress = 1;
          context.status = ConnectionStatus.Done;

          // Emit update
          this.emit('connectionUpdate', this.getConnectionInfo(conn.peer));
        }
      } else {
        // Schedule next chunk
        setTimeout(sendNextChunk, 0);
      }
    };

    // Start sending chunks
    sendNextChunk();
  }

  /**
   * Find a file by name
   */
  private findFile(fileName: string): File | undefined {
    return this.files.find(file => file.name === fileName);
  }

  /**
   * Get file info for all files
   */
  private getFileInfo(): FileInfo[] {
    return this.files.map(file => ({
      fileName: file.name,
      size: file.size,
      type: file.type,
    }));
  }

  /**
   * Get connection info for a specific connection
   */
  private getConnectionInfo(peerId: string): ConnectionInfo {
    const context = this.connections.get(peerId);
    if (!context) {
      throw new Error(`Connection not found: ${peerId}`);
    }

    return {
      id: peerId,
      status: context.status,
      browserName: context.dataConnection.metadata?.browserName,
      browserVersion: context.dataConnection.metadata?.browserVersion,
      osName: context.dataConnection.metadata?.osName,
      osVersion: context.dataConnection.metadata?.osVersion,
      mobileVendor: context.dataConnection.metadata?.mobileVendor,
      mobileModel: context.dataConnection.metadata?.mobileModel,
    };
  }

  /**
   * Get connection info for all connections
   */
  public getConnectionInfoAll(): ConnectionInfo[] {
      const connectionInfos: ConnectionInfo[] = [];

      for (const [peerId, context] of this.connections.entries()) {
      const connectionInfo = this.getConnectionInfo(peerId);
      connectionInfos.push(connectionInfo);
      }

      return connectionInfos;
  }

  /**
   * Remove connection info
   */
  public removeConnectionInfo(connectionId: string): void {
    this.connectionInfoMap.delete(connectionId);
  }

  /**
   * Get total bytes for all files
   */
  private getTotalBytes(): number {
    return this.files.reduce((total, file) => total + file.size, 0);
  }

  /**
   * Get progress info for a specific connection
   */
  private getProgressInfo(peerId: string): ProgressInfo {
    const context = this.connections.get(peerId);
    if (!context) {
      throw new Error(`Connection not found: ${peerId}`);
    }

    return {
      fileIndex: context.fileIndex,
      fileName: context.uploadingFileName || '',
      totalFiles: context.totalFiles,
      currentFileProgress: context.currentFileProgress,
      overallProgress: context.bytesTransferred / context.totalBytes,
      bytesTransferred: context.bytesTransferred,
      totalBytes: context.totalBytes,
    };
  }
}