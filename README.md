# Chat2API

<p align="center">
  <img src="build/icons.png" alt="Chat2API Logo" width="128" height="128">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Release-v1.4.0-blue?style=flat-square&logo=github" alt="Release">
  <img src="https://img.shields.io/badge/License-GPL--3.0-blue?style=flat-square" alt="License">
  <br>
  <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-33+-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron"></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square" alt="Platform">
</p>

<p align="center">
  <strong><a href="README_CN.md">中文</a> | <a href="https://chat2api-doc.vercel.app/">Official Website</a> | <a href="https://chat2api-doc.vercel.app/docs">Documentation</a></strong>
</p>

<p align="center">
  <strong>Multi-platform AI Service Unified Management Tool</strong>
</p>

<p align="center">
  Chat2API enables zero-cost access to leading AI models by leveraging official web UIs. It supports providers such as DeepSeek, GLM, Kimi, MiniMax, Qwen, and Z.ai, and seamlessly integrates with tools like openlcaw, Cline, and Roo-Code — making any OpenAI-compatible client work out of the box.
</p>

![Product Preview](docs/screenshots/preview.png)

## ✨ Features

- OpenAI Compatible API: Provides standard OpenAI-compatible API endpoints for seamless integration
- Multi-Provider Support: Connect DeepSeek (V4 Pro/Flash), GLM, Kimi (K2.6), MiniMax, Perplexity 🆕, Qwen, Z.ai and more
- 🆕 Context Management: Intelligent conversation context management with sliding window, token limit, and summary strategies
- 🆕 Multi-Turn Sessions: Automatic session reuse for multi-turn conversations across all providers
- 🆕 Function Calling Support: Universal tool calling capability for all models via prompt engineering, compatible with Cherry Studio, Kilo Code, and other clients
- 🆕 Model Mapping: Flexible model name mapping with wildcard support and preferred provider/account selection
- 🆕 Custom Parameters: Support for custom HTTP headers to enable web search, thinking mode, and deep research features
- 🆕 Weighted Load Balancing: Account-level weighted random selection for fine-grained traffic control
- 🆕 Credential Encryption: Toggle credential encryption in stored configuration
- Dashboard Monitoring: Real-time request traffic, token usage, and success rates
- API Key Management: Generate and manage keys for your local proxy
- Model Management: View and manage available models from all providers
- Request Logs: Detailed request logging with separate storage for performance
- Proxy Configuration: Flexible proxy settings and routing strategies
- System Tray Integration: Quick access to status from menu bar
- Multilingual: English and Simplified Chinese support
- Modern UI: Clean, responsive interface with dark/light theme support
- Settings Draft Mode: Edit settings with preview before saving

## 🤖 Supported Providers

| Provider         | Auth Type     | OAuth | Models                                                                          |
| ---------------- | ------------- | ----- | ------------------------------------------------------------------------------- |
| DeepSeek         | User Token    | Yes   | DeepSeek V4 Pro, DeepSeek V4 Flash, DeepSeek-V3.2, DeepSeek-R1                 |
| GLM              | Refresh Token | Yes   | GLM-5                                                                           |
| Kimi             | Cookie/Auth   | Yes   | Kimi-K2.6, Kimi-K2.5                                                            |
| MiniMax          | JWT Token     | Yes   | MiniMax-M2.5                                                                    |
| 🆕 Perplexity    | JWT Token     | Yes   | Sonar, Sonar Pro, Sonar Deep Research                                           |
| Qwen (CN)        | SSO Ticket    | Yes   | Qwen3.5-Plus, Qwen3-Max, Qwen3-Flash, Qwen3-Coder, qwen-max-latest              |
| Qwen AI (Global) | JWT Token     | Yes   | Qwen3.5-Plus, Qwen3-Max, Qwen3-VL-Plus, Qwen3-Coder-Plus, Qwen-Plus, Qwen-Turbo |
| Z.ai             | JWT Token     | Yes   | GLM-5, GLM-4.7, GLM-4.6V, GLM-4.6                                               |

## 📥 Installation

### Download

Download the latest release from [GitHub Releases](https://github.com/leisvip/Chat2API/releases):

| Platform              | Download                                |
| --------------------- | --------------------------------------- |
| macOS (Apple Silicon) | `Chat2API-x.x.x-arm64.dmg`              |
| macOS (Intel)         | `Chat2API-x.x.x-x64.dmg`                |
| Windows               | `Chat2API-x.x.x-x64-setup.exe`          |
| Linux                 | `Chat2API-x.x.x-x64.AppImage` or `.deb` |

### Build from Source

**Requirements:**

- Node.js 18+
- npm
- Git

```bash
# Clone the repository
git clone https://github.com/leisvip/Chat2API.git
cd Chat2API

# Install dependencies
npm install

# Start development server
npx electron-vite dev 2>&1
```

### Build for Production

```bash
npm run build              # Build the application
npm run build:mac          # Build for macOS (dmg, zip)
npm run build:win          # Build for Windows (nsis)
npm run build:linux        # Build for Linux (AppImage, deb)
npm run build:all          # Build for all platforms
```

## 📖 Usage

### Step 1: Launch the App

After installation, launch Chat2API. You'll see the main dashboard.

### Step 2: Add a Provider

1. Navigate to **Providers** from the sidebar
2. Click **Add Provider** button
3. Select a built-in provider (e.g., DeepSeek)
4. Enter your authentication credentials

For example, to get a DeepSeek token:

1. Visit [DeepSeek Chat](https://chat.deepseek.com/)
2. Start any conversation
3. Press `F12` to open Developer Tools
4. Go to **Application** > **Local Storage**
5. Find `userToken` and copy its value

### Step 3: Configure Proxy

1. Navigate to **Proxy Settings** from the sidebar
2. Set the port (default: 8080)
3. Choose a load balancing strategy:
   - **Round Robin**: Distributes requests evenly across accounts
   - **Fill First**: Uses one account until limit is reached
   - **Failover**: Automatically switches on failure
4. Click **Start Proxy**

### Step 4: Test the API

Using Python (OpenAI SDK):

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-api-key",
    base_url="http://localhost:8080/v1"
)

response = client.chat.completions.create(
    model="DeepSeek-V3.2",
    messages=[
        {"role": "user", "content": "Hello, who are you?"}
    ]
)

print(response.choices[0].message.content)
```

### Step 5: Manage API Keys (Optional)

For security, you can enable API Key authentication:

1. Go to **API Keys** page
2. Click **New API Key**
3. Enter a name and description
4. Copy the generated key

## 📸 Screenshots

| Dashboard | Providers |
|-----------|-----------|
| ![Dashboard](docs/screenshots/dashboard.png) | ![Providers](docs/screenshots/providers.png) |

| Proxy Settings | API Keys |
|----------------|----------|
| ![Proxy](docs/screenshots/proxy.png) | ![API Keys](docs/screenshots/api-keys.png) |

| Models | Session |
|--------|---------|
| ![Models](docs/screenshots/models.png) | ![Session](docs/screenshots/Session.png) |

## ⚙️ Settings

- **Port**: Change the proxy listening port (default: 8080)
- **Routing Strategy**: Round Robin or Fill First
- **Auto-start**: Launch proxy automatically on app startup
- **Theme**: Light, Dark, or System preference
- **Language**: English or Simplified Chinese

## 🏗️ Architecture

```
Chat2API/
├── src/
│   ├── main/                    # Electron main process
│   │   ├── index.ts            # App entry point
│   │   ├── tray.ts             # System tray integration
│   │   ├── proxy/              # Proxy server management
│   │   ├── ipc/                # IPC handlers
│   │   └── utils/              # Utilities
│   ├── preload/                # Context bridge
│   └── renderer/               # React frontend
│       ├── components/         # UI components
│       ├── pages/              # Page components
│       ├── stores/             # Zustand state
│       └── hooks/              # Custom hooks
├── build/                      # Build resources
└── scripts/                    # Build scripts
```

## 🔧 Tech Stack

| Component | Technology            |
| --------- | --------------------- |
| Framework | Electron 33+          |
| Frontend  | React 18 + TypeScript |
| Styling   | Tailwind CSS          |
| State     | Zustand               |
| Build     | Vite + electron-vite  |
| Packaging | electron-builder      |
| Server    | Koa                   |

## 📁 Data Storage

Application data is stored in `~/.chat2api/` directory:

- `config.json` - Application configuration
- `providers.json` - Provider settings
- `accounts.json` - Account credentials (encrypted)
- `logs/` - Request logs

## ❓ FAQ

### macOS: "App is damaged and can't be opened"

Due to macOS security mechanisms, apps downloaded outside the App Store may trigger this warning. Run the following command to fix it:

```bash
sudo xattr -rd com.apple.quarantine "/Applications/Chat2API.app"
```

### How to update?

Check for updates in the **About** page, or download the latest version from [GitHub Releases](https://github.com/leisvip/Chat2API/releases).

## 🤝 Contributing

1. Fork the project
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

GNU General Public License v3.0. See [LICENSE](LICENSE) for details.

This means:

- ✅ Free to use, modify, and distribute
- ✅ Derivative works must be open-sourced under the same license
- ✅ Must preserve original copyright notices

## 🙏 Acknowledgments

- [Electron](https://www.electronjs.org/) - Cross-platform framework
- [React](https://react.dev/) - UI framework
- [TypeScript](https://www.typescriptlang.org/) - Type-safe JavaScript
- [Tailwind CSS](https://tailwindcss.com/) - CSS framework
- [Zustand](https://zustand-demo.pmnd.rs/) - State management
- [Koa](https://koajs.com/) - HTTP server

