import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

interface MCPTool {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

interface MCPResponse {
  id: string;
  type: 'tool_result' | 'error' | 'list_tools' | 'hello';
  tool_result?: {
    tool_call_id: string;
    result: any;
  };
  error?: {
    message: string;
  };
  tools?: MCPTool[];
  session_id?: string;
}

interface MCPServerConfig {
  name: string;
  transport: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

class MCPClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private stdout: Readable | null = null;
  private stdin: Writable | null = null;
  private buffer: string = '';
  private pendingRequests: Map<string, (response: MCPResponse) => void> = new Map();
  private sessionId: string | null = null;
  private tools: MCPTool[] = [];
  private config: MCPServerConfig;

  constructor(config: MCPServerConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<MCPTool[]> {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.config.command, this.config.args, {
          env: {
            ...process.env,
            ...this.config.env,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.process.stdout || !this.process.stdin) {
          throw new Error('Failed to create stdio streams');
        }

        this.stdout = this.process.stdout;
        this.stdin = this.process.stdin;

        this.stdout.on('data', (data) => {
          this.buffer += data.toString();
          this.processMessages();
        });

        this.stdout.on('end', () => {
          this.emit('disconnect');
        });

        this.process.on('error', (error) => {
          reject(error);
        });

        this.process.on('exit', (code) => {
          if (code !== 0) {
            this.emit('error', new Error(`MCP server exited with code ${code}`));
          }
          this.emit('disconnect');
        });

        // Send hello message
        const helloId = `hello-${Date.now()}`;
        this.pendingRequests.set(helloId, (response) => {
          if (response.type === 'hello') {
            this.sessionId = response.session_id || null;
            // Request tools list
            this.listTools().then(resolve).catch(reject);
          } else {
            reject(new Error('Invalid hello response'));
          }
        });

        this.send({
          id: helloId,
          type: 'hello',
          protocol_version: '1.0',
          client_info: {
            name: 'Chat2API MCP Adapter',
            version: '1.0.0',
          },
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private send(message: any) {
    if (this.stdin) {
      this.stdin.write(JSON.stringify(message) + '\n');
    }
  }

  private processMessages() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line) as MCPResponse;
          const callback = this.pendingRequests.get(message.id);
          if (callback) {
            this.pendingRequests.delete(message.id);
            callback(message);
          }
        } catch (error) {
          console.error('Error parsing MCP message:', error);
        }
      }
    }
  }

  private listTools(): Promise<MCPTool[]> {
    return new Promise((resolve, reject) => {
      const id = `list-tools-${Date.now()}`;
      this.pendingRequests.set(id, (response) => {
        if (response.type === 'list_tools' && response.tools) {
          this.tools = response.tools;
          resolve(response.tools);
        } else {
          reject(new Error('Failed to list tools'));
        }
      });

      this.send({
        id,
        type: 'list_tools',
        session_id: this.sessionId,
      });
    });
  }

  async callTool(toolName: string, parameters: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = `tool-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      this.pendingRequests.set(id, (response) => {
        if (response.type === 'tool_result' && response.tool_result) {
          resolve(response.tool_result.result);
        } else if (response.type === 'error' && response.error) {
          reject(new Error(response.error.message));
        } else {
          reject(new Error('Invalid tool response'));
        }
      });

      this.send({
        id,
        type: 'call_tool',
        session_id: this.sessionId,
        tool_call: {
          name: toolName,
          parameters,
        },
      });
    });
  }

  disconnect() {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.stdout = null;
      this.stdin = null;
    }
  }

  getTools(): MCPTool[] {
    return this.tools;
  }
}

export class MCPAdapter {
  private clients: Map<string, MCPClient> = new Map();
  private defaultServers: MCPServerConfig[] = [
    {
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropic/mcp-filesystem', '/tmp'],
    },
    {
      name: 'brave-search',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropic/mcp-server-brave-search'],
    },
  ];

  async initialize() {
    for (const serverConfig of this.defaultServers) {
      try {
        const client = new MCPClient(serverConfig);
        await client.connect();
        this.clients.set(serverConfig.name, client);
        console.log(`Connected to MCP server: ${serverConfig.name}`);
      } catch (error) {
        console.error(`Failed to connect to MCP server ${serverConfig.name}:`, error);
      }
    }
  }

  getTools() {
    const tools: any[] = [];
    for (const [serverName, client] of this.clients) {
      const serverTools = client.getTools();
      for (const tool of serverTools) {
        tools.push({
          type: 'function',
          function: {
            name: `mcp_${serverName}_${tool.name}`,
            description: tool.description,
            parameters: tool.input_schema,
          },
        });
      }
    }
    return tools;
  }

  async callTool(toolName: string, parameters: any) {
    const match = toolName.match(/^mcp_([^_]+)_(.+)$/);
    if (!match) {
      throw new Error('Invalid MCP tool name format');
    }

    const [, serverName, originalToolName] = match;
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server ${serverName} not found`);
    }

    return await client.callTool(originalToolName, parameters);
  }

  shutdown() {
    for (const client of this.clients.values()) {
      client.disconnect();
    }
  }
}

const mcpAdapter = new MCPAdapter();
export default mcpAdapter;