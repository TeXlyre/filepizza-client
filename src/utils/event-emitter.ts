// src/utils/event-emitter.ts
import { EventEmitter as EventEmitterInterface } from '../core/types'

export class EventEmitter implements EventEmitterInterface {
  private events: Record<string, Array<(...args: any[]) => void>> = {}

  /**
   * Register an event listener
   */
  on(event: string, listener: (...args: any[]) => void): this {
    if (!this.events[event]) {
      this.events[event] = []
    }
    this.events[event].push(listener)
    return this
  }

  /**
   * Remove an event listener
   */
  off(event: string, listener: (...args: any[]) => void): this {
    if (this.events[event]) {
      this.events[event] = this.events[event].filter(l => l !== listener)
    }
    return this
  }

  /**
   * Emit an event
   */
  emit(event: string, ...args: any[]): boolean {
    if (!this.events[event]) {
      return false
    }

    this.events[event].forEach(listener => {
      try {
        listener(...args)
      } catch (error) {
        console.error(`Error in event listener for ${event}:`, error)
      }
    })

    return true
  }

  /**
   * Register a one-time event listener
   */
  once(event: string, listener: (...args: any[]) => void): this {
    const onceListener = (...args: any[]) => {
      this.off(event, onceListener)
      listener(...args)
    }

    return this.on(event, onceListener)
  }

  /**
   * Remove all listeners for an event
   */
  removeAllListeners(event?: string): this {
    if (event) {
      delete this.events[event]
    } else {
      this.events = {}
    }

    return this
  }
}