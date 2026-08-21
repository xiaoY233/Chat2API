/**
 * Proxy Service Module - Route Index
 * Export all routes
 */

import chatRouter from './chat'
import modelsRouter from './models'
import completionsRouter from './completions'
import geminiRouter from './gemini'
import responsesRouter from './responses'

export {
  chatRouter,
  modelsRouter,
  completionsRouter,
  geminiRouter,
  responsesRouter,
}

export default [
  chatRouter,
  modelsRouter,
  completionsRouter,
  geminiRouter,
  responsesRouter,
]
