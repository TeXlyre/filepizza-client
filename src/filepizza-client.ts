import Peer, { DataConnection } from 'peerjs'
import { EventEmitter } from './utils/event-emitter'
import { DownloadHelper } from "./utils/download-helper";

/**
 * Connection status
 */
export enum ConnectionStatus {
  Pending = 'PENDING',
  Ready = 'READY',
  Paused = 'PAUSED',
  Uploading = 'UPLOADING',
  Downloading = 'DOWNLOADING',
  Done = 'DONE',
  Authenticating = 'AUTHENTICATING',
  InvalidPassword = 'INVALID_PASSWORD',
  Closed = 'CLOSED',
  Error = 'ERROR'
}

/**
 * File information
 */
export interface FileInfo {
  fileName: string;
  size: number;
  type: string;
}

/**
 * Progress information
 */
export interface ProgressInfo {
  fileIndex: number;
  fileName: string;
  totalFiles: number;
  currentFileProgress: number;
  overallProgress: number;
  bytesTransferred: number;
  totalBytes: number;
}

/**
 * Connection information
 */
export interface ConnectionInfo {
  id: string;
  status: ConnectionStatus;
  browserName?: string;
  browserVersion?: string;
  osName?: string;
  osVersion?: string;
  mobileVendor?: string;
  mobileModel?: string;
}

/**
 * Message types for peer-to-peer communication
 */
export enum MessageType {
  RequestInfo = 'RequestInfo',
  Info = 'Info',
  Start = 'Start',
  Chunk = 'Chunk',
  Pause = 'Pause',
  Resume = 'Resume',
  Done = 'Done',
  Error = 'Error',
  PasswordRequired = 'PasswordRequired',
  UsePassword = 'UsePassword',
  Report = 'Report',
}

/**
 * FilePizza Uploader - connects to the FilePizza server and uploads files
 */
export class FilePizzaUploader extends EventEmitter {
  private peer?: Peer;
  private connections: Map<string, any> = new Map();
  private files: File[] = [];
  private password?: string;
  private filePizzaServerUrl: string;
  private channelInfo?: { longSlug: string; shortSlug: string; secret?: string };
  private iceServers?: RTCIceServer[];
  private renewalTimer?: NodeJS.Timeout;

  /**
   * Create a new FilePizza uploader
   * @param options Configuration options
   */
  constructor(options: {
    filePizzaServerUrl?: string;
    password?: string;
  } = {}) {
    super();
    this.filePizzaServerUrl = options.filePizzaServerUrl || 'https://file.pizza';
    this.password = options.password;
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
      await this.createChannel(this.peer.id);
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
  private async createChannel(uploaderPeerID: string): Promise<void> {
    try {
      const response = await fetch(`${this.filePizzaServerUrl}/api/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploaderPeerID }),
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
    conn.metadata = {
      browserName: message.browserName,
      browserVersion: message.browserVersion,
      osName: message.osName,
      osVersion: message.osVersion,
      mobileVendor: message.mobileVendor,
      mobileModel: message.mobileModel,
    };

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
   * Get total bytes for all files
   */
  private getTotalBytes(): number {
    return this.files.reduce((total, file) => total + file.size, 0);
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

/**
 * FilePizza Downloader - connects to FilePizza uploads
 */
export class FilePizzaDownloader extends EventEmitter {
  private peer?: Peer;
  private connection?: DataConnection;
  private filePizzaServerUrl: string;
  private filesInfo: FileInfo[] = [];
  private currentFileIndex = 0;
  private currentFileBytesReceived = 0;
  private totalBytesReceived = 0;
  private totalBytes = 0;
  private status = ConnectionStatus.Pending;
  private fileStreams: Map<string, {
    stream: ReadableStream<Uint8Array>;
    enqueue: (chunk: Uint8Array) => void;
    close: () => void;
  }> = new Map();
  private isPasswordRequired = false;
  private isPasswordInvalid = false;
  private errorMessage?: string;
  private iceServers?: RTCIceServer[];

  /**
   * Create a new FilePizza downloader
   * @param options Configuration options
   */
  constructor(options: {
    filePizzaServerUrl?: string;
  } = {}) {
    super();
    this.filePizzaServerUrl = options.filePizzaServerUrl || 'https://file.pizza';
  }

  /**
   * Initialize the downloader
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
  }

  /**
   * Connect to an uploader using a FilePizza URL or slug
   */
  async connect(urlOrSlug: string): Promise<boolean> {
    // Extract slug from URL if needed
    const slug = this.extractSlug(urlOrSlug);

    try {
      // Look up the uploader's peer ID
      const uploaderPeerID = await this.lookupUploaderPeerID(slug);

      // Now connect directly to the uploader
      return this.connectToPeer(uploaderPeerID);
    } catch (error) {
      this.errorMessage = `Failed to connect: ${error instanceof Error ? error.message : String(error)}`;
      this.emit('error', this.errorMessage);
      return false;
    }
  }

  /**
   * Submit password for protected download
   */
  submitPassword(password: string): void {
    if (!this.connection || this.status !== ConnectionStatus.Authenticating) {
      throw new Error('Not in authentication state');
    }

    this.connection.send({
      type: MessageType.UsePassword,
      password,
    });
  }

  /**
   * Start downloading the files
   */
  async startDownload(): Promise<void> {
    // This is just a stub - actual implementation will depend on how you want to save files
    // The real FilePizza implementation uses the StreamSaver library

    if (!this.connection) {
      throw new Error('Not connected');
    }

    if (this.filesInfo.length === 0) {
      throw new Error('No files available');
    }

    if (this.status !== ConnectionStatus.Ready) {
      throw new Error(`Cannot start download in current state: ${this.status}`);
    }

    this.status = ConnectionStatus.Downloading;
    this.currentFileIndex = 0;
    this.currentFileBytesReceived = 0;
    this.totalBytesReceived = 0;

    // Initialize file streams
    this.initializeFileStreams();

    // Request the first file
    this.requestNextFile();
  }

  /**
   * Pause the download
   */
  pauseDownload(): void {
    if (!this.connection || this.status !== ConnectionStatus.Downloading) {
      return;
    }

    this.connection.send({ type: MessageType.Pause });
    this.status = ConnectionStatus.Paused;
    this.emit('paused');
  }

  /**
   * Resume the download
   */
  resumeDownload(): void {
    if (!this.connection || this.status !== ConnectionStatus.Paused) {
      return;
    }

    const currentFile = this.filesInfo[this.currentFileIndex];

    this.connection.send({
      type: MessageType.Resume,
      fileName: currentFile.fileName,
      offset: this.currentFileBytesReceived,
    });

    this.status = ConnectionStatus.Downloading;
    this.emit('resumed');
  }

  /**
   * Cancel the download
   */
  cancelDownload(): void {
    // Close all file streams
    for (const { close } of this.fileStreams.values()) {
      close();
    }
    this.fileStreams.clear();

    // Close the connection
    if (this.connection) {
      if (this.connection.open) {
        this.connection.close();
      }
      this.connection = undefined;
    }

    this.status = ConnectionStatus.Closed;
    this.emit('cancelled');
  }

  /**
   * Get file information
   */
  getFileInfo(): FileInfo[] {
    return this.filesInfo;
  }

  /**
   * Get download status
   */
  getStatus(): {
    status: ConnectionStatus;
    isPasswordRequired: boolean;
    isPasswordInvalid: boolean;
    errorMessage?: string;
  } {
    return {
      status: this.status,
      isPasswordRequired: this.isPasswordRequired,
      isPasswordInvalid: this.isPasswordInvalid,
      errorMessage: this.errorMessage,
    };
  }

  /**
   * Get progress information
   */
  getProgress(): ProgressInfo {
    return {
      fileIndex: this.currentFileIndex,
      fileName: this.filesInfo[this.currentFileIndex]?.fileName || '',
      totalFiles: this.filesInfo.length,
      currentFileProgress: this.currentFileBytesReceived /
        (this.filesInfo[this.currentFileIndex]?.size || 1),
      overallProgress: this.totalBytesReceived / (this.totalBytes || 1),
      bytesTransferred: this.totalBytesReceived,
      totalBytes: this.totalBytes,
    };
  }

  /**
   * Extract slug from URL or use directly
   */
  private extractSlug(urlOrSlug: string): string {
    // Check if it's a URL
    if (urlOrSlug.startsWith('http')) {
      const url = new URL(urlOrSlug);
      const pathParts = url.pathname.split('/').filter(Boolean);

      // Extract the download slug
      if (pathParts[0] === 'download' && pathParts.length > 1) {
        return pathParts.slice(1).join('/');
      } else {
        throw new Error('Invalid FilePizza URL');
      }
    }

    // If it's not a URL, assume it's already a slug
    return urlOrSlug;
  }

  /**
   * Look up the uploader's peer ID from the FilePizza server
   */
  private async lookupUploaderPeerID(slug: string): Promise<string> {
    console.log("this is the download url", `${this.filePizzaServerUrl}/download/${slug}`)
    try {
      const response = await fetch(`${this.filePizzaServerUrl}/download/${slug}`);

      if (!response.ok) {
        throw new Error(`FilePizza server returned ${response.status}`);
      }

      const html = await response.text();

      if (!html || html.trim() === '') {
        throw new Error('Received empty response from server');
      }

      // Updated regex to match the JSON format with escaped quotes
      const match = html.match(/\\"uploaderPeerID\\":\\"([^\\]+)\\"/);

      if (!match || !match[1]) {
        throw new Error('Could not find uploader peer ID');
      }

      return match[1];
    } catch (error) {
      console.error('Error looking up uploader peer ID:', error);
      throw new Error('Failed to look up uploader information');
    }
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
   * Connect directly to a peer
   */
  private async connectToPeer(peerId: string): Promise<boolean> {
    // Make sure we're initialized
    await this.initialize();

    if (!this.peer) {
      throw new Error('Peer not initialized');
    }

    try {
      // Close existing connection if any
      if (this.connection) {
        this.connection.close();
      }

      // Connect to the uploader
      this.connection = this.peer.connect(peerId, { reliable: true });
      this.status = ConnectionStatus.Pending;

      // Set up connection event handlers
      return new Promise<boolean>((resolve) => {
        if (!this.connection) {
          resolve(false);
          return;
        }

        this.connection.on('open', () => {
          this.status = ConnectionStatus.Ready;

          // Send request for file info
          if (this.connection) {
            this.connection.send({
              type: MessageType.RequestInfo,
              browserName: this.getBrowserName(),
              browserVersion: this.getBrowserVersion(),
              osName: this.getOSName(),
              osVersion: this.getOSVersion(),
              mobileVendor: this.getMobileVendor(),
              mobileModel: this.getMobileModel(),
            });
          }

          this.emit('connected');
          resolve(true);
        });

        this.connection.on('data', this.handleData.bind(this));

        this.connection.on('close', () => {
          this.status = ConnectionStatus.Closed;
          this.emit('disconnected');
        });

        this.connection.on('error', (error) => {
          this.errorMessage = `Connection error: ${error.message}`;
          this.status = ConnectionStatus.Error;
          this.emit('error', this.errorMessage);
        });
      });
    } catch (error) {
      this.errorMessage = `Failed to connect: ${error instanceof Error ? error.message : String(error)}`;
      this.emit('error', this.errorMessage);
      return false;
    }
  }

  /**
   * Handle incoming data from uploader
   */
  private handleData(data: unknown): void {
    try {
      // WebRTC messages follow a specific format with a type field
      const message = data as any;

      switch (message.type) {
        case MessageType.PasswordRequired:
          this.handlePasswordRequired(message);
          break;

        case MessageType.Info:
          this.handleInfo(message);
          break;

        case MessageType.Chunk:
          this.handleChunk(message);
          break;

        case MessageType.Error:
          this.handleError(message);
          break;

        case MessageType.Report:
          this.handleReport();
          break;
      }
    } catch (error) {
      console.error('Error handling message:', error);
      this.errorMessage = `Error processing data: ${error instanceof Error ? error.message : String(error)}`;
      this.emit('error', this.errorMessage);
    }
  }

  /**
   * Handle password required message
   */
  private handlePasswordRequired(message: any): void {
    this.isPasswordRequired = true;
    this.status = ConnectionStatus.Authenticating;

    if (message.errorMessage) {
      this.errorMessage = message.errorMessage;
      this.isPasswordInvalid = true;
      this.emit('passwordInvalid', message.errorMessage);
    } else {
      this.emit('passwordRequired');
    }
  }

  /**
   * Handle file info message
   */
  private handleInfo(message: any): void {
    this.filesInfo = message.files;
    this.totalBytes = this.filesInfo.reduce((sum: number, file: FileInfo) => sum + file.size, 0);
    this.isPasswordRequired = false;
    this.isPasswordInvalid = false;
    this.status = ConnectionStatus.Ready;

    this.emit('info', this.filesInfo);
  }

  /**
   * Handle error message
   */
  private handleError(message: any): void {
    this.errorMessage = message.error;
    this.status = ConnectionStatus.Error;
    this.emit('error', this.errorMessage);
  }

  /**
   * Handle report message (channel reported for violation)
   */
  private handleReport(): void {
    this.emit('reported');

    // Redirect to reported page if in browser
    if (typeof window !== 'undefined') {
      window.location.href = `${this.filePizzaServerUrl}/reported`;
    }
  }

  /**
   * Handle chunk message
   */
  private handleChunk(message: any): void {
    const { fileName, bytes, final } = message;
    const fileStream = this.fileStreams.get(fileName);

    if (!fileStream) {
      console.error(`No stream found for file: ${fileName}`);
      return;
    }

    // Convert bytes to Uint8Array if needed
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    // Update progress
    this.currentFileBytesReceived += data.byteLength;
    this.totalBytesReceived += data.byteLength;

    // Add to file stream
    fileStream.enqueue(data);

    // Emit progress
    this.emit('progress', this.getProgress());

    // Handle file completion
    if (final) {
      // Close this file's stream
      fileStream.close();

      // Trigger the file download
      this.saveFileToDevice(fileName);

      // Move to next file if available
      this.currentFileIndex++;
      this.currentFileBytesReceived = 0;

      if (this.currentFileIndex < this.filesInfo.length) {
        this.requestNextFile();
      } else {
        this.status = ConnectionStatus.Done;
        this.emit('complete');
      }
    }
  }

  /**
   * Initialize streams for all files
   */
  private initializeFileStreams(): void {
    this.fileStreams.clear();

    for (const fileInfo of this.filesInfo) {
      let enqueue: ((chunk: Uint8Array) => void) | null = null;
      let close: (() => void) | null = null;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          enqueue = (chunk: Uint8Array) => controller.enqueue(chunk);
          close = () => controller.close();
        },
      });

      if (!enqueue || !close) {
        throw new Error('Failed to initialize stream controllers');
      }

      this.fileStreams.set(fileInfo.fileName, {
        stream,
        enqueue,
        close,
      });
    }
  }

  /**
   * Save file to the user's device
   */
  private async saveFileToDevice(fileName: string): Promise<void> {
    const fileStream = this.fileStreams.get(fileName);

    if (!fileStream) {
      console.error(`No stream found for file: ${fileName}`);
      return;
    }

    try {
      // Clone the stream since we can only use it once
      const clonedStream = fileStream.stream.tee()[0];

      // Download the file
      await DownloadHelper.downloadFile(fileName, clonedStream);
    } catch (error) {
      console.error(`Error saving file ${fileName}:`, error);
      this.emit('error', `Failed to save file: ${error.message}`);
    }
  }

  /**
   * Request the next file
   */
  private requestNextFile(): void {
    if (!this.connection || this.currentFileIndex >= this.filesInfo.length) {
      return;
    }

    const nextFile = this.filesInfo[this.currentFileIndex];

    this.connection.send({
      type: MessageType.Start,
      fileName: nextFile.fileName,
      offset: 0,
    });
  }

  // Browser detection helper methods
  private getBrowserName(): string {
    if (typeof navigator === 'undefined') return 'unknown';
    const ua = navigator.userAgent;
    if (ua.includes('Firefox')) return 'Firefox';
    if (ua.includes('Chrome')) return 'Chrome';
    if (ua.includes('Safari')) return 'Safari';
    if (ua.includes('Edge')) return 'Edge';
    if (ua.includes('MSIE') || ua.includes('Trident/')) return 'IE';
    return 'unknown';
  }

  private getBrowserVersion(): string {
    if (typeof navigator === 'undefined') return 'unknown';
    const ua = navigator.userAgent;

    let match;
    if ((match = ua.match(/(Firefox|Chrome|Safari|Edge|MSIE)\/(\d+\.\d+)/))) {
      return match[2];
    }
    if ((match = ua.match(/rv:(\d+\.\d+)/))) {
      return match[1];
    }

    return 'unknown';
  }

  private getOSName(): string {
    if (typeof navigator === 'undefined') return 'unknown';
    const ua = navigator.userAgent;

    if (ua.includes('Windows')) return 'Windows';
    if (ua.includes('Mac OS X')) return 'macOS';
    if (ua.includes('Linux')) return 'Linux';
    if (ua.includes('Android')) return 'Android';
    if (ua.includes('iOS')) return 'iOS';

    return 'unknown';
  }

  private getOSVersion(): string {
    if (typeof navigator === 'undefined') return 'unknown';
    const ua = navigator.userAgent;

    let match;
    if ((match = ua.match(/Windows NT (\d+\.\d+)/))) {
      return match[1];
    }
    if ((match = ua.match(/Mac OS X (\d+[._]\d+)/))) {
      return match[1].replace('_', '.');
    }
    if ((match = ua.match(/Android (\d+\.\d+)/))) {
      return match[1];
    }
    if ((match = ua.match(/iPhone OS (\d+_\d+)/))) {
      return match[1].replace('_', '.');
    }

    return 'unknown';
  }

  private getMobileVendor(): string {
    if (typeof navigator === 'undefined') return '';

    const ua = navigator.userAgent;
    if (ua.includes('iPhone') || ua.includes('iPad')) return 'Apple';
    if (ua.includes('Samsung')) return 'Samsung';
    if (ua.includes('Pixel')) return 'Google';
    if (ua.includes('Huawei')) return 'Huawei';

    return '';
  }

  private getMobileModel(): string {
    if (typeof navigator === 'undefined') return '';

    const ua = navigator.userAgent;
    let match;

    if ((match = ua.match(/iPhone(\d+),(\d+)/))) {
      return `iPhone ${match[1]}`;
    }
    if ((match = ua.match(/iPad(\d+),(\d+)/))) {
      return `iPad ${match[1]}`;
    }
    if ((match = ua.match(/SM-\w+/))) {
      return match[0];
    }
    if ((match = ua.match(/Pixel \d+/))) {
      return match[0];
    }

    return '';
  }
}