# OpenClaw MCP 工具集成

内置 MCP (Model Context Protocol) 工具调用功能，无需配置即可提供给 OpenClaw 调用。

## 功能特性

- 内置 MCP 工具调用功能，无需额外配置
- 自动连接常用 MCP 服务器（文件系统、搜索等）
- 支持 OpenClaw 直接调用 MCP 工具
- 无需安装额外插件或依赖

## 支持的 MCP 服务器

- **filesystem**: 文件系统操作工具
- **brave-search**: 网络搜索工具

## 如何使用

1. **启动应用**：启动 Chat2API 应用
2. **MCP 工具自动初始化**：应用启动时会自动连接内置的 MCP 服务器
3. **在 OpenClaw 中使用**：AI 可以直接调用以下格式的工具：
   - `mcp_filesystem_*` - 文件系统操作工具
   - `mcp_brave-search_*` - 网络搜索工具

## 示例

### 搜索网络

```json
{
  "tool_calls": [
    {
      "id": "call_1",
      "type": "function",
      "function": {
        "name": "mcp_brave-search_search",
        "arguments": "{\"query\": \"OpenClaw MCP integration\", \"count\": 5}"
      }
    }
  ]
}
```

### 读取文件

```json
{
  "tool_calls": [
    {
      "id": "call_1",
      "type": "function",
      "function": {
        "name": "mcp_filesystem_read",
        "arguments": "{\"path\": \"/tmp/test.txt\"}"
      }
    }
  ]
}
```

## 技术实现

- **MCP 适配器**：实现了 MCP 协议的客户端
- **自动初始化**：应用启动时自动连接 MCP 服务器
- **工具注册**：将 MCP 工具注册为 OpenClaw 可用工具
- **调用处理**：处理 OpenClaw 的工具调用请求并转发给 MCP 服务器

## 构建与安装

1. **安装依赖**：
   ```bash
   npm install
   ```

2. **构建应用**：
   ```bash
   npm run build
   ```

3. **运行应用**：
   ```bash
   npm start
   ```

## 注意事项

- MCP 服务器会在后台运行，可能会消耗一定的系统资源
- 首次启动时需要下载 MCP 服务器依赖，可能会需要一些时间
- 部分 MCP 工具可能需要 API 密钥，请确保在环境变量中设置

## 许可证

MIT License