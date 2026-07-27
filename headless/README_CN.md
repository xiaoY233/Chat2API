# Chat2API Headless

该目录提供独立的纯 Node.js 兼容层。它复用上游 Koa、路由、Store 和供应商 Adapter，但最终镜像不包含 Electron、Chromium、Xvfb 或桌面环境。

## 支持范围

| Provider | 必填凭据 | 可选凭据 |
|---|---|---|
| DeepSeek | `token` | 无 |
| GLM | `refresh_token` | 无 |
| Z.ai | `token` | `captcha_verify_param` |
| Kimi | `token` | 无 |
| MiniMax | `token` | `realUserID` |

不支持 Perplexity、Qwen、qwen-ai、Mimo、GUI OAuth 和内置网页登录。请在自己的电脑浏览器中登录供应商网站并取得凭据，然后通过 SSH 录入。

## 凭据位置

| Provider | 获取方式 |
|---|---|
| DeepSeek | 浏览器开发者工具 → Application → Local Storage，查找用户 Token |
| GLM | 智谱清言网页的 Local Storage 中查找 `chatglm_refresh_token` |
| Z.ai | Cookie 中的 `token`；发生验证码校验时从最新聊天请求体取得 `captcha_verify_param` |
| Kimi | Cookie 中的 `kimi-auth`，也可使用 JWT 或 refresh token |
| MiniMax | JWT Token；也可使用 `realUserID+JWTtoken` 格式，或单独填写 `realUserID` |

不要把凭据直接写在 Shell 命令参数、Compose 文件或 Git 仓库中。

## 构建镜像

默认由 `.github/workflows/headless-image.yml` 构建 `linux/amd64` 镜像并推送到 GHCR。

1. 将本项目 fork 到自己的 GitHub 账户。
2. 在仓库 Actions 页面启用工作流。
3. 手工运行 `Headless Image`，或向 `main` 推送相关改动。
4. 在仓库 Packages 页面确认 `chat2api-headless` 镜像存在。
5. 建议将 Package 可见性设为 private 或只允许必要账户读取。

发布标签包括：

```text
ghcr.io/<owner>/chat2api-headless:sha-<完整commit>
ghcr.io/<owner>/chat2api-headless:latest
ghcr.io/<owner>/chat2api-headless:<Chat2API版本>（仅版本标签触发时发布）
```

生产部署优先使用不可变的 SHA 标签。普通 `main` 构建只发布 SHA 和 `latest`；版本标签仅在 `v*` Git tag 触发时发布。

## VPS 准备

目标环境：Ubuntu 24.04 x86_64、Docker Engine 和 Compose Plugin。

确认架构：

```bash
uname -m
```

预期输出：

```text
x86_64
```

1 核 2 GB 可以运行低并发服务。建议保留 1-2 GB swap，尤其是在 VPS 上还运行其他服务时：

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

如果系统已经有 swap，不要重复创建。使用 `swapon --show` 检查。

## 部署

在 VPS 上通过 SSH 执行：

```bash
git clone https://github.com/<你的账户>/Chat2API.git
cd Chat2API/headless
cp .env.example .env
```

编辑 `.env`：

```env
CHAT2API_IMAGE=ghcr.io/<你的账户>/chat2api-headless:sha-<GitHub Actions构建的完整commit>
CHAT2API_HOST_PORT=8080
```

私有 GHCR 镜像需要登录：

```bash
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u '<你的GitHub用户名>' --password-stdin
unset GHCR_TOKEN
```

启动：

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose exec chat2api chat2api-ctl status
```

服务只发布到 VPS 的 `127.0.0.1`，不会直接监听公网接口。

## 添加账户

交互式输入会隐藏敏感字段：

```bash
docker compose exec chat2api chat2api-ctl account add deepseek --name deepseek-main
docker compose exec chat2api chat2api-ctl account add glm --name glm-main
docker compose exec chat2api chat2api-ctl account add zai --name zai-main
docker compose exec chat2api chat2api-ctl account add kimi --name kimi-main
docker compose exec chat2api chat2api-ctl account add minimax --name minimax-main
```

创建后 CLI 默认立即验证凭据。若供应商暂时不可达，可使用 `--no-validate`，稍后执行：

```bash
docker compose exec chat2api chat2api-ctl accounts
docker compose exec chat2api chat2api-ctl account validate <account-id>
```

脚本化录入示例：

```bash
read -rsp 'DeepSeek token: ' TOKEN
echo
jq -n --arg token "$TOKEN" \
  '{providerId:"deepseek",name:"deepseek-main",credentials:{token:$token}}' |
docker compose exec -T chat2api chat2api-ctl account add --stdin
unset TOKEN
```

删除错误账户：

```bash
docker compose exec chat2api chat2api-ctl account delete <account-id>
```

Token 更新或失效后重新录入：

```bash
docker compose exec chat2api chat2api-ctl account update <account-id>
```

## 创建 API Key

账户配置完成后创建 OpenAI API Key：

```bash
docker compose exec chat2api chat2api-ctl api-key create --name primary
```

CLI 会创建 Key、开启 API Key 校验并验证 `/v1/models`。完整 Key 只显示一次，请立即保存在密码管理器中。

查看脱敏后的 Key 列表：

```bash
docker compose exec chat2api chat2api-ctl api-key list
```

## SSH 隧道

在本地电脑执行：

```bash
ssh -N -L 8080:127.0.0.1:8080 <VPS用户>@<VPS地址>
```

客户端配置：

```text
Base URL: http://127.0.0.1:8080/v1
API Key:  chat2api-ctl 创建的 Key
```

测试：

```bash
curl http://127.0.0.1:8080/v1/models \
  -H 'Authorization: Bearer <API_KEY>'
```

## 状态和日志

```bash
docker compose exec chat2api chat2api-ctl snapshot
docker compose logs --tail=100 chat2api
docker stats chat2api-headless
```

不要把容器日志上传到公共位置。兼容层会移除当前已知的凭据调试日志，但供应商未来新增的日志仍需在升级时审查。

## 更新和回滚

上游更新后，先在 GitHub Actions 构建新镜像并确认测试通过，然后修改 `.env` 中的固定标签：

```bash
docker compose pull
docker compose up -d
docker compose exec chat2api chat2api-ctl status
```

回滚时将 `.env` 改回旧标签，再执行相同命令。不要删除数据卷。

## 备份

数据与 Master Key 必须一起备份：

```bash
docker compose stop
docker run --rm \
  -v chat2api-headless-data:/data:ro \
  -v "$PWD":/backup \
  alpine:3.21 \
  tar czf /backup/chat2api-headless-backup.tgz -C /data .
docker compose start
```

恢复前先停止服务，并将备份恢复到同一个数据卷。丢失 `master.key` 后无法恢复账户凭据。

恢复工具可能改变文件所有者。恢复后执行：

```bash
docker run --rm -v chat2api-headless-data:/data alpine:3.21 \
  chown -R 10001:10001 /data
```

默认情况下密文、Master Key 和 Management Secret 位于同一个受保护数据卷，主要防止意外明文泄漏，不能抵御已经取得 Docker/宿主 root 权限的攻击者。请限制 Docker 管理权限和备份访问权限。

## 本地开发验证

```bash
cd headless
npm ci
npm run check
```

Docker 验证：

```bash
docker build -f headless/Dockerfile -t chat2api-headless:dev .
```

构建会在临时目录中应用安全和 MiniMax HTTP/2 修补；不会修改上游 `src/`。如果上游相关代码发生变化，构建会失败并指出不再适用的补丁。
