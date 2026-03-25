# Chat2API Manager v1.1.4 Release Notes

## 🎉 Major Features

### Clear Chat History
- **Qwen AI**: Add "Clear Chat History" feature to delete all conversation history from Qwen AI website
- **MiniMax**: Add batch delete functionality to remove all conversations
- Confirmation dialog with warning message to prevent accidental deletion
- Available in account context menu for supported providers

### Enhanced Thinking Mode Control (Qwen AI)
- Support model name suffixes for fine-grained control:
  - `-thinking`: Force enable thinking mode
  - `-fast`: Force disable thinking mode (fast responses)
- Default to disable thinking mode and auto-search for faster responses
- Explicit `enable_thinking` parameter support

### Improved Credit Display (MiniMax)
- Updated to use new membership API endpoint
- Added credit expiration timestamp display
- Shows remaining daily login gift credits

## 🚀 Improvements

### Request Logging Enhancement
- Added response body logging for both streaming and non-streaming requests
- Added `web_search` and `reasoning_effort` fields to request logs
- Improved error response logging
- Enhanced log detail view with new "Response" tab

### Multi-Provider Adapter Improvements
- **Kimi**: Improved thinking mode detection with explicit phase tracking (thinking/answer)
- **Qwen/Qwen-AI**: Enhanced parent_id handling for better multi-turn conversation support
- **Minimax**: Optimized tool call support and request handling
- **DeepSeek**: Improved fold/search models streaming with default content path

### Multi-Turn Conversation Support
- Fixed parent message ID updates for non-stream responses
- Improved conversation context retention
- Better session management for continuous dialogues

### UI/UX Enhancements
- Redesigned log detail modal with improved layout
- Added response body preview in log details
- Added web search and reasoning effort indicators
- Improved account management with clear chats feature

## 🐛 Bug Fixes

- Fixed DeepSeek web search model streaming issues
- Fixed Qwen AI non-stream empty content handling
- Fixed Perplexity error handling
- Fixed duplicate resolve in Qwen AI handleNonStream
- Fixed Z.ai non-stream response handling
- Corrected handleNonStream parameter handling in multiple adapters

## 📦 Technical Updates

- Updated electron-builder configuration
- Improved TypeScript type definitions
- Enhanced error handling and logging
- Added backward compatible model name mappings

## 📝 Notes

- Application data stored in `~/.chat2api/`
- Supports macOS, Windows, and Linux
- Requires Electron 33+
