/**
 * Proxy Service Module - Route Index
 * Export all routes
 */

import chatRouter from './chat'
import modelsRouter from './models'
import completionsRouter from './completions'
import messagesRouter from './messages'

export {
  chatRouter,
  modelsRouter,
  completionsRouter,
  messagesRouter,
}

export default [
  chatRouter,
  modelsRouter,
  completionsRouter,
  messagesRouter,
]
