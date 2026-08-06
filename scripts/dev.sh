#!/bin/bash
# Chat2API 开发启动脚本
# 自动处理 root 用户环境下的沙箱问题和无显示环境

cd "$(dirname "$0")/.."

# 检测操作系统
OS="$(uname -s)"

# macOS 使用 Quartz 显示服务器，不需要检查 DISPLAY
if [ "$OS" = "Darwin" ]; then
    # 检查是否以 root 用户运行
    if [ "$(id -u)" = "0" ]; then
        echo "检测到以 root 用户运行，使用 --no-sandbox 参数"
        npx electron-vite dev -- --no-sandbox
    else
        npx electron-vite dev
    fi
    exit 0
fi

# Linux 系统检查是否有显示服务器
if [ -z "$DISPLAY" ]; then
    echo "未检测到显示服务器，使用虚拟显示 (Xvfb)"
    # 使用 xvfb-run 运行
    if command -v xvfb-run &> /dev/null; then
        xvfb-run --auto-servernum --server-args="-screen 0 1024x768x24" npx electron-vite dev -- --no-sandbox
    else
        echo "错误: Xvfb 未安装，无法在无显示环境下运行"
        echo "请安装: apt-get install xvfb"
        exit 1
    fi
else
    # 检查是否以 root 用户运行
    if [ "$(id -u)" = "0" ]; then
        echo "检测到以 root 用户运行，使用 --no-sandbox 参数"
        npx electron-vite dev -- --no-sandbox
    else
        npx electron-vite dev
    fi
fi
