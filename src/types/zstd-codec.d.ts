declare module 'zstd-codec' {
  interface ZstdSimple {
    compress(data: Uint8Array, level?: number): Uint8Array
    decompress(data: Uint8Array): Uint8Array
  }
  
  interface ZstdStreaming {
    compress(): void
    decompress(): void
  }
  
  interface Zstd {
    Simple: new() => ZstdSimple
    Streaming: new() => ZstdStreaming
  }
  
  export function run(callback: (zstd: Zstd) => void): void
}
