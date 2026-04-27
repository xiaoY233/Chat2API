const fs = require('fs') as typeof import('fs')
import * as path from 'path'

interface WriteRecord {
  filePath: string
  bytes: number
  timestamp: number
  source?: string
}

class DiskMonitor {
  private enabled = false
  private records: WriteRecord[] = []
  private timer: NodeJS.Timeout | null = null
  private readonly REPORT_INTERVAL_MS = 10000

  private originalWriteFile: typeof fs.writeFile
  private originalWriteFileSync: typeof fs.writeFileSync
  private originalPromisesWriteFile: typeof fs.promises.writeFile

  constructor() {
    this.originalWriteFile = fs.writeFile
    this.originalWriteFileSync = fs.writeFileSync
    this.originalPromisesWriteFile = fs.promises.writeFile
  }

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    this.records = []
    this.interceptFs()
    this.timer = setInterval(() => this.report(), this.REPORT_INTERVAL_MS)
    console.log('[DiskMonitor] Enabled. Reporting every 10s.')
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.restoreFs()
    console.log('[DiskMonitor] Disabled.')
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Record a write operation manually (e.g. from electron-store.set)
   */
  record(filePath: string, bytes: number, source?: string): void {
    if (!this.enabled) return
    this.records.push({
      filePath,
      bytes,
      timestamp: Date.now(),
      source,
    })
  }

  private interceptFs(): void {
    const monitor = this

    // Intercept fs.writeFile
    fs.writeFile = function (
      file: string | Buffer | URL | number,
      data: string | NodeJS.ArrayBufferView,
      ...args: any[]
    ): void {
      const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data as string)
      monitor.record(String(file), bytes, 'fs.writeFile')
      monitor.originalWriteFile.call(fs, file as any, data as any, ...args)
    } as any

    // Intercept fs.writeFileSync
    fs.writeFileSync = function (
      file: string | Buffer | URL | number,
      data: string | NodeJS.ArrayBufferView,
      ...args: any[]
    ): void {
      const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data as string)
      monitor.record(String(file), bytes, 'fs.writeFileSync')
      return monitor.originalWriteFileSync.call(fs, file as any, data as any, ...args)
    } as any

    // Intercept fs.promises.writeFile
    fs.promises.writeFile = function (
      file: string | Buffer | URL | fs.promises.FileHandle,
      data: string | NodeJS.ArrayBufferView,
      ...args: any[]
    ): Promise<void> {
      const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data as string)
      monitor.record(String(file), bytes, 'fs.promises.writeFile')
      return monitor.originalPromisesWriteFile.call(fs.promises, file as any, data as any, ...args)
    } as any
  }

  private restoreFs(): void {
    fs.writeFile = this.originalWriteFile
    fs.writeFileSync = this.originalWriteFileSync
    fs.promises.writeFile = this.originalPromisesWriteFile
  }

  private report(): void {
    const now = Date.now()
    const windowStart = now - this.REPORT_INTERVAL_MS
    const recent = this.records.filter(r => r.timestamp >= windowStart)

    if (recent.length === 0) {
      console.log('[DiskMonitor] No writes in last 10s')
      return
    }

    const totalBytes = recent.reduce((sum, r) => sum + r.bytes, 0)
    const totalCount = recent.length
    const avgBytes = Math.round(totalBytes / totalCount)
    const rateMBs = (totalBytes / this.REPORT_INTERVAL_MS * 1000 / 1024 / 1024).toFixed(2)

    // Group by file
    const byFile = new Map<string, { count: number; bytes: number }>()
    for (const r of recent) {
      const key = path.basename(r.filePath)
      const existing = byFile.get(key) || { count: 0, bytes: 0 }
      existing.count++
      existing.bytes += r.bytes
      byFile.set(key, existing)
    }

    const topFiles = [...byFile.entries()]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, 5)
      .map(([name, stat]) => `${name}: ${stat.count}次 ${(stat.bytes / 1024).toFixed(1)}KB`)

    console.log(
      `[DiskMonitor] ${this.REPORT_INTERVAL_MS / 1000}s 统计 | ` +
      `写入 ${totalCount} 次 | 总 ${(totalBytes / 1024).toFixed(1)}KB | ` +
      `平均 ${avgBytes}B/次 | 速率 ${rateMBs}MB/s`
    )
    console.log(`[DiskMonitor] Top files: ${topFiles.join(' | ')}`)

    // Keep only last 2 windows to prevent memory leak
    this.records = this.records.filter(r => r.timestamp >= windowStart - this.REPORT_INTERVAL_MS)
  }
}

export const diskMonitor = new DiskMonitor()
