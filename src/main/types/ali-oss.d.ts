declare module 'ali-oss' {
  interface OSSOptions {
    accessKeyId: string
    accessKeySecret: string
    bucket: string
    endpoint: string
    stsToken?: string
  }

  interface PutResult {
    name: string
    url: string
    res: any
  }

  class OSS {
    constructor(options: OSSOptions)
    put(name: string, data: Buffer | string): Promise<PutResult>
  }

  export default OSS
}
