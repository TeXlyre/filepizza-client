// src/filepizza-uploader.ts
import Peer, { DataConnection } from 'peerjs'
import { EventEmitter } from './event-emitter'
import {
  FileInfo,
  ProgressInfo,
  ConnectionInfo,
  ConnectionStatus,
  MessageType,
  PeerJSSignalingServer,
} from './types'
import { createPeer } from './peerjs'

type ChannelInfo = {
  longSlug: string
  shortSlug: string
  secret?: string
}

type UploaderOptions = {
  filePizzaServerUrl?: string
  password?: string
  sharedSlug?: string
  peerJSSignalingServer?: PeerJSSignalingServer
  discoverPeerJSSignalingServer?: boolean
}

/**
 * FilePizza Uploader - connects to the FilePizza server and uploads files.
 */
export class FilePizzaUploader extends EventEmitter {
  private peer?: Peer
  private connections: Map<string, any> = new Map()
  private connectionInfoMap = new Map<string, any>()
  private files: File[] = []
  private password?: string
  private filePizzaServerUrl: string
  private channelInfo?: ChannelInfo
  private sharedSlug?: string
  private renewalTimer?: NodeJS.Timeout
  private peerJSSignalingServer?: PeerJSSignalingServer
  private discoverPeerJSSignalingServer: boolean

  constructor(options: UploaderOptions = {}) {
    super()
    this.filePizzaServerUrl = options.filePizzaServerUrl || 'http://localhost:8081'
    this.password = options.password
    this.sharedSlug = options.sharedSlug
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

    this.peer.on('connection', this.handleConnection.bind(this))

    await this.createChannel(this.peer.id, this.sharedSlug || undefined)
    this.startChannelRenewal()
  }

  setPassword(password: string): void {
    this.password = password
  }

  setFiles(files: File[]): void {
    this.files = Array.from(files)

    if (this.files.length > 0) {
      for (const [, connection] of this.connections.entries()) {
        if (connection.status === ConnectionStatus.Ready) {
          connection.dataConnection.send({
            type: MessageType.Info,
            files: this.getFileInfo(),
          })
        }
      }
    }
  }

  getShareableLinks(): { long: string; short: string } | null {
    if (!this.channelInfo) {
      return null
    }

    return {
      long: `${this.filePizzaServerUrl}/download/${this.channelInfo.longSlug}`,
      short: `${this.filePizzaServerUrl}/download/${this.channelInfo.shortSlug}`,
    }
  }

  async stop(): Promise<void> {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer)
      this.renewalTimer = undefined
    }

    if (this.channelInfo) {
      try {
        await this.destroyChannel(this.channelInfo.shortSlug)
      } catch (error) {
        console.error('Error destroying channel:', error)
      }
    }

    for (const [, connection] of this.connections.entries()) {
      if (connection.dataConnection.open) {
        connection.dataConnection.close()
      }
    }

    this.connections.clear()

    if (this.peer) {
      this.peer.destroy()
      this.peer = undefined
    }

    this.channelInfo = undefined
  }

  private async createChannel(
    uploaderPeerID: string,
    sharedSlug?: string,
  ): Promise<void> {
    const payload: { uploaderPeerID: string; sharedSlug?: string } = {
      uploaderPeerID,
    }

    if (sharedSlug) {
      payload.sharedSlug = sharedSlug
    }

    const response = await fetch(`${this.filePizzaServerUrl}/api/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      throw new Error(`Failed to create channel: ${response.status}`)
    }

    this.channelInfo = await response.json()
  }

  private async renewChannel(): Promise<void> {
    if (!this.channelInfo || !this.channelInfo.secret) {
      return
    }

    try {
      const response = await fetch(`${this.filePizzaServerUrl}/api/renew`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: this.channelInfo.shortSlug,
          secret: this.channelInfo.secret,
        }),
      })

      if (!response.ok) {
        throw new Error(`Failed to renew channel: ${response.status}`)
      }
    } catch (error) {
      console.error('Error renewing channel:', error)
    }
  }

  private async destroyChannel(slug: string): Promise<void> {
    try {
      const response = await fetch(`${this.filePizzaServerUrl}/api/destroy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      })

      if (!response.ok) {
        throw new Error(`Failed to destroy channel: ${response.status}`)
      }
    } catch (error) {
      console.error('Error destroying channel:', error)
    }
  }

  private startChannelRenewal(): void {
    if (!this.channelInfo || !this.channelInfo.secret) {
      return
    }

    this.renewalTimer = setInterval(
      () => {
        this.renewChannel()
      },
      30 * 60 * 1000,
    )
  }

  private handleConnection(conn: DataConnection): void {
    if (conn.metadata?.type === 'report') {
      this.emit('report', conn.peer)
      return
    }

    const connectionContext = {
      status: ConnectionStatus.Pending,
      dataConnection: conn,
      fileIndex: 0,
      filesInfo: this.getFileInfo(),
      totalFiles: this.files.length,
      bytesTransferred: 0,
      totalBytes: this.getTotalBytes(),
      currentFileProgress: 0,
      acknowledgedBytes: 0,
    }

    this.connections.set(conn.peer, connectionContext)

    conn.on('data', (data) => this.handleData(conn, data))
    conn.on('close', () => this.handleClose(conn))
    conn.on('error', (error) => this.handleError(conn, error))

    this.emit('connection', this.getConnectionInfo(conn.peer))
  }

  private handleData(conn: DataConnection, data: unknown): void {
    const context = this.connections.get(conn.peer)
    if (!context) return

    try {
      const message = data as any

      switch (message.type) {
        case MessageType.RequestInfo:
          this.handleRequestInfo(conn, context, message)
          break

        case MessageType.UsePassword:
          this.handleUsePassword(conn, context, message)
          break

        case MessageType.Start:
          this.handleStart(conn, context, message)
          break

        case MessageType.Pause:
          this.handlePause(conn, context)
          break

        case MessageType.ChunkAck:
          this.handleChunkAck(conn, context, message)
          break

        case MessageType.Done:
          this.handleDone(conn, context)
          break
      }
    } catch (error) {
      console.error('[FilePizzaUploader] Error handling message:', error)
      conn.send({
        type: MessageType.Error,
        error: 'Failed to process message',
      })
    }
  }

  private handleClose(conn: DataConnection): void {
    const context = this.connections.get(conn.peer)
    if (!context) return

    context.status = ConnectionStatus.Closed
    this.emit('disconnection', conn.peer)
    this.connections.delete(conn.peer)
  }

  private handleError(conn: DataConnection, error: Error): void {
    const context = this.connections.get(conn.peer)
    if (!context) return

    context.status = ConnectionStatus.Error
    this.emit('error', { connectionId: conn.peer, error })

    if (conn.open) {
      conn.close()
    }
  }

  private handleRequestInfo(conn: DataConnection, context: any, message: any): void {
    this.connectionInfoMap.set(conn.connectionId, {
      browserName: message.browserName,
      browserVersion: message.browserVersion,
      osName: message.osName,
      osVersion: message.osVersion,
      mobileVendor: message.mobileVendor,
      mobileModel: message.mobileModel,
    })

    const connectionInfo = {
      browserName: message.browserName,
      browserVersion: message.browserVersion,
      osName: message.osName,
      osVersion: message.osVersion,
      mobileVendor: message.mobileVendor,
      mobileModel: message.mobileModel,
    }

    if (this.password) {
      conn.send({
        type: MessageType.PasswordRequired,
      })

      context.status = ConnectionStatus.Authenticating
      Object.assign(context, connectionInfo)

      this.emit('connectionUpdate', this.getConnectionInfo(conn.peer))
      return
    }

    conn.send({
      type: MessageType.Info,
      files: context.filesInfo,
    })

    context.status = ConnectionStatus.Ready
    Object.assign(context, connectionInfo)

    this.emit('connectionUpdate', this.getConnectionInfo(conn.peer))
  }

  private handleUsePassword(conn: DataConnection, context: any, message: any): void {
    if (message.password === this.password) {
      conn.send({
        type: MessageType.Info,
        files: context.filesInfo,
      })

      context.status = ConnectionStatus.Ready
    } else {
      conn.send({
        type: MessageType.PasswordRequired,
        errorMessage: 'Invalid password',
      })

      context.status = ConnectionStatus.InvalidPassword
    }

    this.emit('connectionUpdate', this.getConnectionInfo(conn.peer))
  }

  private handleStart(conn: DataConnection, context: any, message: any): void {
    const fileName = message.fileName
    const offset = message.offset

    const file = this.findFile(fileName)
    if (!file || offset > file.size) {
      conn.send({
        type: MessageType.Error,
        error: `Invalid file or offset: ${fileName}`,
      })
      return
    }

    context.status = ConnectionStatus.Uploading
    context.uploadingFileName = fileName
    context.uploadingOffset = offset
    context.acknowledgedBytes = 0
    context.currentFileProgress = 0

    this.emit('connectionUpdate', this.getConnectionInfo(conn.peer))
    this.sendFileChunks(conn, context, file, offset)
  }

  private handlePause(conn: DataConnection, context: any): void {
    context.status = ConnectionStatus.Paused
    this.emit('connectionUpdate', this.getConnectionInfo(conn.peer))
  }

  private handleChunkAck(conn: DataConnection, context: any, message: any): void {
    context.acknowledgedBytes =
      (context.acknowledgedBytes || 0) + message.bytesReceived

    const file = this.findFile(message.fileName)
    if (file) {
      context.currentFileProgress = context.acknowledgedBytes / file.size
    }

    this.emit('progress', this.getProgressInfo(conn.peer))
  }

  private handleDone(conn: DataConnection, context: any): void {
    context.status = ConnectionStatus.Done
    this.emit('connectionUpdate', this.getConnectionInfo(conn.peer))
    conn.close()
  }

  private sendFileChunks(
    conn: DataConnection,
    context: any,
    file: File,
    startOffset: number,
  ): void {
    let offset = startOffset
    const chunkSize = 256 * 1024

    const sendNextChunk = () => {
      if (!conn.open || context.status !== ConnectionStatus.Uploading) {
        return
      }

      const end = Math.min(file.size, offset + chunkSize)
      const final = end >= file.size
      const sentBytes = end - offset

      conn.send({
        type: MessageType.Chunk,
        fileName: file.name,
        offset,
        bytes: file.slice(offset, end),
        final,
      })

      offset = end
      context.uploadingOffset = offset
      context.bytesTransferred += sentBytes

      if (final) {
        if (context.fileIndex < context.totalFiles - 1) {
          context.fileIndex += 1
          context.currentFileProgress = 0
          context.status = ConnectionStatus.Ready
        } else {
          context.fileIndex = context.totalFiles
          context.currentFileProgress = 1
          context.status = ConnectionStatus.Ready
        }

        this.emit('connectionUpdate', this.getConnectionInfo(conn.peer))
      } else {
        setTimeout(sendNextChunk, 0)
      }
    }

    sendNextChunk()
  }

  private findFile(fileName: string): File | undefined {
    return this.files.find((file) => file.name === fileName)
  }

  private getFileInfo(): FileInfo[] {
    return this.files.map((file) => ({
      fileName: file.name,
      size: file.size,
      type: file.type,
    }))
  }

  private getConnectionInfo(peerId: string): ConnectionInfo {
    const context = this.connections.get(peerId)
    if (!context) {
      throw new Error(`Connection not found: ${peerId}`)
    }

    return {
      id: peerId,
      status: context.status,
      browserName: context.browserName,
      browserVersion: context.browserVersion,
      osName: context.osName,
      osVersion: context.osVersion,
      mobileVendor: context.mobileVendor,
      mobileModel: context.mobileModel,
    }
  }

  public getConnectionInfoAll(): ConnectionInfo[] {
    return Array.from(this.connections.keys()).map((peerId) =>
      this.getConnectionInfo(peerId),
    )
  }

  public removeConnectionInfo(connectionId: string): void {
    this.connectionInfoMap.delete(connectionId)
  }

  private getTotalBytes(): number {
    return this.files.reduce((total, file) => total + file.size, 0)
  }

  private getProgressInfo(peerId: string): ProgressInfo {
    const context = this.connections.get(peerId)
    if (!context) {
      throw new Error(`Connection not found: ${peerId}`)
    }

    return {
      fileIndex: context.fileIndex,
      fileName: context.uploadingFileName || '',
      totalFiles: context.totalFiles,
      currentFileProgress: context.currentFileProgress,
      overallProgress: context.bytesTransferred / (context.totalBytes || 1),
      bytesTransferred: context.bytesTransferred,
      totalBytes: context.totalBytes,
    }
  }
}
