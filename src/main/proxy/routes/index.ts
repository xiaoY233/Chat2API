/**
 * Proxy Service Module - Route Index
 * Export all routes
 */

import chatRouter from './chat'
import modelsRouter from './models'
import completionsRouter from './completions'

export {
  chatRouter,
  modelsRouter,
  completionsRouter,
}

export default [
  chatRouter,
  modelsRouter,
  completionsRouter,
]
