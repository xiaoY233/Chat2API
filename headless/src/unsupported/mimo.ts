export class MimoAdapter {
  static isMimoProvider(): boolean { return false }
  constructor() { throw new Error('Mimo is not supported by Chat2API Headless') }
}

export class MimoStreamHandler {
  constructor() { throw new Error('Mimo is not supported by Chat2API Headless') }
}

export const mimoAdapter = { MimoAdapter, MimoStreamHandler }
