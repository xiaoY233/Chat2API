declare module 'ali-oss' {
  interface OSSOptions {
    accessKeyId: string
    accessKeySecret: string
    bucket: string
    endpoint: string
    region?: string
    stsToken?: string
    authorizationV4?: boolean
    timeout?: number
    retryMax?: number
    refreshSTSToken?: () => Promise<{
      accessKeyId: string
      accessKeySecret: string
      stsToken: string
    }>
    refreshSTSTokenInterval?: number
  }

  interface PutResult {
    name: string
    url: string
    res: any
  }

  class OSS {
    constructor(options: OSSOptions)
    put(name: string, data: Buffer | string | NodeJS.ReadableStream, options?: any): Promise<PutResult>
    multipartUpload(name: string, data: Buffer | string | NodeJS.ReadableStream, options?: any): Promise<any>
  }

  export default OSS
}
