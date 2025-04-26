// src/filepizza-downloader.ts
import Peer, { DataConnection } from 'peerjs'
import { EventEmitter } from './event-emitter'
import { DownloadHelper } from './download-helper';
import { FileInfo, ProgressInfo, ConnectionStatus, CompletedFile, MessageType } from './types'

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
  private completedFiles: CompletedFile[] = [];

  /**
   * Create a new FilePizza downloader
   * @param options Configuration options
   */
  constructor(options: {
    filePizzaServerUrl?: string;
  } = {}) {
    super();
    this.filePizzaServerUrl = options.filePizzaServerUrl || 'http://localhost:8081';
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

      // Store the completed file
      this.storeCompletedFile(fileName);

      // Move to next file if available
      this.currentFileIndex++;
      this.currentFileBytesReceived = 0;

      if (this.currentFileIndex < this.filesInfo.length) {
        this.requestNextFile();
      } else {
        this.status = ConnectionStatus.Done;
        this.emit('complete', this.completedFiles);
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
   * Store a completed file
   */
  private async storeCompletedFile(fileName: string): Promise<void> {
    const fileStream = this.fileStreams.get(fileName);
    const fileInfo = this.filesInfo.find(info => info.fileName === fileName);

    if (!fileStream || !fileInfo) {
      console.error(`No stream or file info found for file: ${fileName}`);
      return;
    }

    try {
      // Clone the stream since we're going to use it
      const [streamToRead, streamToStore] = fileStream.stream.tee();

      // Convert stream to Uint8Array
      const fileData = await DownloadHelper.streamToUint8Array(streamToRead);

      // Store the completed file
      const completedFile: CompletedFile = {
        ...fileInfo,
        data: fileData,
      };

      this.completedFiles.push(completedFile);

      // Emit fileComplete event
      this.emit('fileComplete', completedFile);
    } catch (error) {
      console.error(`Error storing file ${fileName}:`, error);
      this.emit('error', `Failed to store file: ${error.message}`);
    }
  }

  /**
   * Download a completed file
   */
  public async downloadFile(fileName: string): Promise<void> {
    const completedFile = this.completedFiles.find(file => file.fileName === fileName);

    if (!completedFile) {
      throw new Error(`File not found: ${fileName}`);
    }

    try {
      await DownloadHelper.downloadFile(fileName, completedFile.data);
    } catch (error) {
      console.error(`Error downloading file ${fileName}:`, error);
      throw new Error(`Failed to download file: ${error.message}`);
    }
  }

  /**
   * Get completed files
   */
  public getCompletedFiles(): CompletedFile[] {
    return [...this.completedFiles];
  }

  /**
   * Download all completed files
   */
  public async downloadAllFiles(): Promise<void> {
    for (const file of this.completedFiles) {
      try {
        await this.downloadFile(file.fileName);
      } catch (error) {
        console.error(`Error downloading file ${file.fileName}:`, error);
        // Continue with other files even if one fails
      }
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