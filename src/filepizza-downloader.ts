// src/filepizza-downloader.ts
import Peer, { DataConnection } from 'peerjs'
import { EventEmitter } from './event-emitter'
import { DownloadHelper } from './download-helper'
import {
  FileInfo,
  ProgressInfo,
  ConnectionStatus,
  CompletedFile,
  MessageType,
  PeerJSSignalingServer,
} from './types'
import { createPeer } from './peerjs'

type DownloaderOptions = {
  filePizzaServerUrl?: string
  peerJSSignalingServer?: PeerJSSignalingServer
  discoverPeerJSSignalingServer?: boolean
}

type ChannelLookupResponse = {
  uploaderPeerID: string
  additionalUploaders?: string[]
}

/**
 * FilePizza Downloader - connects to FilePizza uploads.
 */
export class FilePizzaDownloader extends EventEmitter {
  private peer?: Peer
  private connection?: DataConnection
  private filePizzaServerUrl: string
  private filesInfo: FileInfo[] = []
  private currentFileIndex = 0
  private currentFileBytesReceived = 0
  private totalBytesReceived = 0
  private totalBytes = 0
  private status = ConnectionStatus.Pending
  private fileStreams: Map<
    string,
    {
      stream: ReadableStream<Uint8Array>
      enqueue: (chunk: Uint8Array) => void
      close: () => void
    }
  > = new Map()
  private isPasswordRequired = false
  private isPasswordInvalid = false
  private errorMessage?: string
  private completedFiles: CompletedFile[] = []
  private peerJSSignalingServer?: PeerJSSignalingServer
  private discoverPeerJSSignalingServer: boolean

  constructor(options: DownloaderOptions = {}) {
    super()
    this.filePizzaServerUrl = options.filePizzaServerUrl || 'http://localhost:8081'
    this.peerJSSignalingServer = options.peerJSSignalingServer
    this.discoverPeerJSSignalingServer =
      options.discoverPeerJSSignalingServer ?? true
  }

  async initialize(): Promise<void> {
    if (this.peer) {
      return
    }

    this.peer = await createPeer({
      filePizzaServerUrl: this.filePizzaServerUrl,
      peerJSSignalingServer: this.peerJSSignalingServer,
      discoverPeerJSSignalingServer: this.discoverPeerJSSignalingServer,
    })
  }

  async connect(urlOrSlug: string): Promise<boolean> {
    this.resetConnectionState()

    const slug = this.extractSlug(urlOrSlug)

    try {
      const uploaderPeerID = await this.lookupUploaderPeerID(slug)
      return this.connectToPeer(uploaderPeerID)
    } catch (error) {
      this.errorMessage = `Failed to connect: ${error instanceof Error ? error.message : String(error)
        }`
      this.emit('error', this.errorMessage)
      return false
    }
  }

  private resetConnectionState(): void {
    this.cleanupFileStreams()

    this.filesInfo = []
    this.currentFileIndex = 0
    this.currentFileBytesReceived = 0
    this.totalBytesReceived = 0
    this.totalBytes = 0
    this.completedFiles = []
    this.isPasswordRequired = false
    this.isPasswordInvalid = false
    this.errorMessage = undefined
    this.status = ConnectionStatus.Pending

    if (this.connection && this.connection.open) {
      this.connection.close()
    }

    this.connection = undefined
  }

  submitPassword(password: string): void {
    if (!this.connection || this.status !== ConnectionStatus.Authenticating) {
      throw new Error('Not in authentication state')
    }

    this.connection.send({
      type: MessageType.UsePassword,
      password,
    })
  }

  async startDownload(): Promise<void> {
    if (!this.connection) {
      throw new Error('Not connected')
    }

    if (this.filesInfo.length === 0) {
      throw new Error('No files available')
    }

    if (this.status !== ConnectionStatus.Ready) {
      throw new Error(`Cannot start download in current state: ${this.status}`)
    }

    this.status = ConnectionStatus.Downloading
    this.currentFileIndex = 0
    this.currentFileBytesReceived = 0
    this.totalBytesReceived = 0

    this.initializeFileStreams()
    this.requestNextFile()
  }

  pauseDownload(): void {
    if (!this.connection || this.status !== ConnectionStatus.Downloading) {
      return
    }

    this.connection.send({ type: MessageType.Pause })
    this.status = ConnectionStatus.Paused
    this.emit('paused')
  }

  /**
   * Kept for public API compatibility.
   *
   * The server frontend protocol currently supports pause/stop, not resume.
   * A paused transfer should be restarted by creating a new connection.
   */
  resumeDownload(): void {
    if (this.status !== ConnectionStatus.Paused) {
      return
    }

    this.errorMessage =
      'Resume is not supported by the current FilePizza server protocol. Please reconnect and restart the download.'
    this.status = ConnectionStatus.Error
    this.emit('error', this.errorMessage)
  }

  cancelDownload(): void {
    this.cleanupFileStreams()

    if (this.connection) {
      if (this.connection.open) {
        this.connection.close()
      }
      this.connection = undefined
    }

    this.status = ConnectionStatus.Closed
    this.emit('cancelled')
  }

  private cleanupFileStreams(): void {
    for (const [fileName, fileStreamData] of this.fileStreams.entries()) {
      try {
        if (fileStreamData.stream.locked === false) {
          fileStreamData.close()
        }
      } catch (error) {
        console.warn(`Error closing stream for ${fileName}:`, error)
      }
    }

    this.fileStreams.clear()
  }

  getFileInfo(): FileInfo[] {
    return this.filesInfo
  }

  getStatus(): {
    status: ConnectionStatus
    isPasswordRequired: boolean
    isPasswordInvalid: boolean
    errorMessage?: string
  } {
    return {
      status: this.status,
      isPasswordRequired: this.isPasswordRequired,
      isPasswordInvalid: this.isPasswordInvalid,
      errorMessage: this.errorMessage,
    }
  }

  getProgress(): ProgressInfo {
    return {
      fileIndex: this.currentFileIndex,
      fileName: this.filesInfo[this.currentFileIndex]?.fileName || '',
      totalFiles: this.filesInfo.length,
      currentFileProgress:
        this.currentFileBytesReceived /
        (this.filesInfo[this.currentFileIndex]?.size || 1),
      overallProgress: this.totalBytesReceived / (this.totalBytes || 1),
      bytesTransferred: this.totalBytesReceived,
      totalBytes: this.totalBytes,
    }
  }

  private extractSlug(urlOrSlug: string): string {
    if (urlOrSlug.startsWith('http')) {
      const url = new URL(urlOrSlug)
      const pathParts = url.pathname.split('/').filter(Boolean)

      if (pathParts[0] === 'download' && pathParts.length > 1) {
        return pathParts.slice(1).join('/')
      }

      throw new Error('Invalid FilePizza URL')
    }

    return urlOrSlug
  }

  private async fetchChannel(slug: string): Promise<ChannelLookupResponse> {
    const response = await fetch(`${this.filePizzaServerUrl}/api/channel/${slug}`)

    if (!response.ok) {
      throw new Error(`FilePizza server returned ${response.status}`)
    }

    return response.json()
  }

  /**
   * Fallback for older FilePizza servers that do not expose /api/channel/:slug.
   */
  private async extractUploaderPeerIDsFromHtml(slug: string): Promise<string[]> {
    const response = await fetch(`${this.filePizzaServerUrl}/download/${slug}`)

    if (!response.ok) {
      throw new Error(`FilePizza server returned ${response.status}`)
    }

    const html = await response.text()

    if (!html || html.trim() === '') {
      throw new Error('Received empty response from server')
    }

    const primaryMatch = html.match(/\\"primaryUploaderID\\":\\"([^\\]+)\\"/)
    const singleMatch = html.match(/\\"uploaderPeerID\\":\\"([^\\]+)\\"/)

    if (primaryMatch && primaryMatch[1]) {
      const uploaderIDs = [primaryMatch[1]]

      const additionalMatch = html.match(/\\"additionalUploaders\\":\[([^\]]+)\]/)
      if (additionalMatch && additionalMatch[1]) {
        const additionalIDs = additionalMatch[1]
          .split(',')
          .map((id) => id.trim().replace(/\\"|"/g, ''))
          .filter((id) => id.length > 0)

        uploaderIDs.push(...additionalIDs)
      }

      return uploaderIDs
    }

    if (singleMatch && singleMatch[1]) {
      return [singleMatch[1]]
    }

    throw new Error('Could not find uploader peer ID')
  }

  private async extractUploaderPeerIDs(slug: string): Promise<string[]> {
    try {
      const channel = await this.fetchChannel(slug)
      return [
        channel.uploaderPeerID,
        ...(channel.additionalUploaders || []),
      ].filter(Boolean)
    } catch (error) {
      console.warn(
        'Falling back to HTML parsing because /api/channel lookup failed:',
        error,
      )

      return this.extractUploaderPeerIDsFromHtml(slug)
    }
  }

  private async lookupUploaderPeerID(slug: string): Promise<string> {
    const uploaderIDs = await this.extractUploaderPeerIDs(slug)

    if (uploaderIDs.length === 0) {
      throw new Error('No uploader peer IDs found')
    }

    return uploaderIDs[0]
  }

  public async getAvailableUploaders(urlOrSlug: string): Promise<string[]> {
    const slug = this.extractSlug(urlOrSlug)
    return this.extractUploaderPeerIDs(slug)
  }

  public async connectToUploader(uploaderId: string): Promise<boolean> {
    try {
      return this.connectToPeer(uploaderId)
    } catch (error) {
      this.errorMessage = `Failed to connect to uploader: ${error instanceof Error ? error.message : String(error)
        }`
      this.emit('error', this.errorMessage)
      return false
    }
  }

  private async connectToPeer(peerId: string): Promise<boolean> {
    await this.initialize()

    if (!this.peer) {
      throw new Error('Peer not initialized')
    }

    try {
      if (this.connection) {
        this.connection.close()
      }

      this.connection = this.peer.connect(peerId, { reliable: true })
      this.status = ConnectionStatus.Pending

      return new Promise<boolean>((resolve) => {
        if (!this.connection) {
          resolve(false)
          return
        }

        this.connection.on('open', () => {
          this.status = ConnectionStatus.Ready

          this.connection?.send({
            type: MessageType.RequestInfo,
            browserName: this.getBrowserName(),
            browserVersion: this.getBrowserVersion(),
            osName: this.getOSName(),
            osVersion: this.getOSVersion(),
            mobileVendor: this.getMobileVendor(),
            mobileModel: this.getMobileModel(),
          })

          this.emit('connected')
          resolve(true)
        })

        this.connection.on('data', this.handleData.bind(this))

        this.connection.on('close', () => {
          this.status = ConnectionStatus.Closed
          this.emit('disconnected')
        })

        this.connection.on('error', (error) => {
          this.errorMessage = `Connection error: ${error.message}`
          this.status = ConnectionStatus.Error
          this.emit('error', this.errorMessage)
        })
      })
    } catch (error) {
      this.errorMessage = `Failed to connect: ${error instanceof Error ? error.message : String(error)
        }`
      this.emit('error', this.errorMessage)
      return false
    }
  }

  private handleData(data: unknown): void {
    try {
      const message = data as any

      switch (message.type) {
        case MessageType.PasswordRequired:
          this.handlePasswordRequired(message)
          break

        case MessageType.Info:
          this.handleInfo(message)
          break

        case MessageType.Chunk:
          this.handleChunk(message)
          break

        case MessageType.Error:
          this.handleError(message)
          break

        case MessageType.Report:
          this.handleReport()
          break
      }
    } catch (error) {
      console.error('Error handling message:', error)
      this.errorMessage = `Error processing data: ${error instanceof Error ? error.message : String(error)
        }`
      this.emit('error', this.errorMessage)
    }
  }

  private handlePasswordRequired(message: any): void {
    this.isPasswordRequired = true
    this.status = ConnectionStatus.Authenticating

    if (message.errorMessage) {
      this.errorMessage = message.errorMessage
      this.isPasswordInvalid = true
      this.emit('passwordInvalid', message.errorMessage)
    } else {
      this.emit('passwordRequired')
    }
  }

  private handleInfo(message: any): void {
    this.filesInfo = message.files
    this.totalBytes = this.filesInfo.reduce(
      (sum: number, file: FileInfo) => sum + file.size,
      0,
    )
    this.isPasswordRequired = false
    this.isPasswordInvalid = false
    this.errorMessage = undefined
    this.status = ConnectionStatus.Ready

    this.emit('info', this.filesInfo)
  }

  private handleError(message: any): void {
    this.errorMessage = message.error
    this.status = ConnectionStatus.Error
    this.emit('error', this.errorMessage)
  }

  private handleReport(): void {
    this.emit('reported')

    if (typeof window !== 'undefined') {
      window.location.href = `${this.filePizzaServerUrl}/reported`
    }
  }

  private handleChunk(message: any): void {
    const { fileName, bytes, final, offset } = message
    const fileStream = this.fileStreams.get(fileName)

    if (!fileStream) {
      console.error(`No stream found for file: ${fileName}`)
      return
    }

    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)

    this.currentFileBytesReceived += data.byteLength
    this.totalBytesReceived += data.byteLength

    try {
      fileStream.enqueue(data)
    } catch (error) {
      console.error(`Error enqueueing data for ${fileName}:`, error)
      return
    }

    this.connection?.send({
      type: MessageType.ChunkAck,
      fileName,
      offset,
      bytesReceived: data.byteLength,
    })

    this.emit('progress', this.getProgress())

    if (final) {
      try {
        fileStream.close()
      } catch (error) {
        console.warn(`Error closing stream for ${fileName}:`, error)
      }

      this.storeCompletedFile(fileName)

      this.currentFileIndex++
      this.currentFileBytesReceived = 0

      if (this.currentFileIndex < this.filesInfo.length) {
        this.requestNextFile()
      } else {
        this.status = ConnectionStatus.Done
        this.connection?.send({ type: MessageType.Done })
        this.emit('complete', this.completedFiles)
      }
    }
  }

  private initializeFileStreams(): void {
    this.cleanupFileStreams()

    for (const fileInfo of this.filesInfo) {
      let enqueue: ((chunk: Uint8Array) => void) | null = null
      let close: (() => void) | null = null

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          enqueue = (chunk: Uint8Array) => controller.enqueue(chunk)
          close = () => {
            try {
              controller.close()
            } catch (error) {
              console.warn('Controller already closed:', error)
            }
          }
        },
      })

      if (!enqueue || !close) {
        throw new Error('Failed to initialize stream controllers')
      }

      this.fileStreams.set(fileInfo.fileName, {
        stream,
        enqueue,
        close,
      })
    }
  }

  private async storeCompletedFile(fileName: string): Promise<void> {
    const fileStream = this.fileStreams.get(fileName)
    const fileInfo = this.filesInfo.find((info) => info.fileName === fileName)

    if (!fileStream || !fileInfo) {
      console.error(`No stream or file info found for file: ${fileName}`)
      return
    }

    try {
      const fileData = await DownloadHelper.streamToUint8Array(fileStream.stream)

      const completedFile: CompletedFile = {
        ...fileInfo,
        data: fileData,
      }

      this.completedFiles.push(completedFile)
      this.emit('fileComplete', completedFile)
    } catch (error: any) {
      console.error(`Error storing file ${fileName}:`, error)
      this.emit('error', `Failed to store file: ${error.message}`)
    }
  }

  public async downloadFile(fileName: string): Promise<void> {
    const completedFile = this.completedFiles.find(
      (file) => file.fileName === fileName,
    )

    if (!completedFile) {
      throw new Error(`File not found: ${fileName}`)
    }

    try {
      await DownloadHelper.downloadFile(fileName, completedFile.data)
    } catch (error: any) {
      console.error(`Error downloading file ${fileName}:`, error)
      throw new Error(`Failed to download file: ${error.message}`)
    }
  }

  public getCompletedFiles(): CompletedFile[] {
    return [...this.completedFiles]
  }

  public async downloadAllFiles(): Promise<void> {
    for (const file of this.completedFiles) {
      try {
        await this.downloadFile(file.fileName)
      } catch (error) {
        console.error(`Error downloading file ${file.fileName}:`, error)
      }
    }
  }

  private requestNextFile(): void {
    if (!this.connection || this.currentFileIndex >= this.filesInfo.length) {
      return
    }

    const nextFile = this.filesInfo[this.currentFileIndex]

    this.connection.send({
      type: MessageType.Start,
      fileName: nextFile.fileName,
      offset: 0,
    })
  }

  private getBrowserName(): string {
    if (typeof navigator === 'undefined') return 'unknown'
    const ua = navigator.userAgent
    if (ua.includes('Firefox')) return 'Firefox'
    if (ua.includes('Chrome')) return 'Chrome'
    if (ua.includes('Safari')) return 'Safari'
    if (ua.includes('Edge')) return 'Edge'
    if (ua.includes('MSIE') || ua.includes('Trident/')) return 'IE'
    return 'unknown'
  }

  private getBrowserVersion(): string {
    if (typeof navigator === 'undefined') return 'unknown'
    const ua = navigator.userAgent

    let match
    if ((match = ua.match(/(Firefox|Chrome|Safari|Edge|MSIE)\/(\d+\.\d+)/))) {
      return match[2]
    }
    if ((match = ua.match(/rv:(\d+\.\d+)/))) {
      return match[1]
    }

    return 'unknown'
  }

  private getOSName(): string {
    if (typeof navigator === 'undefined') return 'unknown'
    const ua = navigator.userAgent

    if (ua.includes('Windows')) return 'Windows'
    if (ua.includes('Mac OS X')) return 'macOS'
    if (ua.includes('Linux')) return 'Linux'
    if (ua.includes('Android')) return 'Android'
    if (ua.includes('iOS')) return 'iOS'

    return 'unknown'
  }

  private getOSVersion(): string {
    if (typeof navigator === 'undefined') return 'unknown'
    const ua = navigator.userAgent

    let match
    if ((match = ua.match(/Windows NT (\d+\.\d+)/))) {
      return match[1]
    }
    if ((match = ua.match(/Mac OS X (\d+[._]\d+)/))) {
      return match[1].replace('_', '.')
    }
    if ((match = ua.match(/Android (\d+\.\d+)/))) {
      return match[1]
    }
    if ((match = ua.match(/iPhone OS (\d+_\d+)/))) {
      return match[1].replace('_', '.')
    }

    return 'unknown'
  }

  private getMobileVendor(): string {
    if (typeof navigator === 'undefined') return ''

    const ua = navigator.userAgent
    if (ua.includes('iPhone') || ua.includes('iPad')) return 'Apple'
    if (ua.includes('Samsung')) return 'Samsung'
    if (ua.includes('Pixel')) return 'Google'
    if (ua.includes('Huawei')) return 'Huawei'

    return ''
  }

  private getMobileModel(): string {
    if (typeof navigator === 'undefined') return ''

    const ua = navigator.userAgent
    let match

    if ((match = ua.match(/iPhone(\d+),(\d+)/))) {
      return `iPhone ${match[1]}`
    }
    if ((match = ua.match(/iPad(\d+),(\d+)/))) {
      return `iPad ${match[1]}`
    }
    if ((match = ua.match(/SM-\w+/))) {
      return match[0]
    }
    if ((match = ua.match(/Pixel \d+/))) {
      return match[0]
    }

    return ''
  }
}
