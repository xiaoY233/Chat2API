#!/usr/bin/env bash
set -euo pipefail

log() { printf '[Chat2API 更新] %s\n' "$*"; }
die() { printf '[Chat2API 更新] 错误：%s\n' "$*" >&2; exit 1; }
require_root() { [ "$(id -u)" -eq 0 ] || die "请使用 root 或 sudo 执行。"; }

load_meta() {
  local file="$1" key value
  TYPE=""; SCHEMA_VERSION=""; AUTH_MODE=""; PROJECT_NAME=""; PORT=""; VERSION=""; SOURCE_HEAD=""; APP_DIR=""; SOURCE_DIR=""; DATA_DIR=""
  ENV_FILE=""; KEY_FILE=""; SECRET_FILE=""; CONTAINER_NAME=""; IMAGE_TAG=""; REPOSITORY=""; GIT_REF="main"
  while IFS='=' read -r key value; do
    case "$key" in
      TYPE|SCHEMA_VERSION|AUTH_MODE|PROJECT_NAME|PORT|VERSION|SOURCE_HEAD|APP_DIR|SOURCE_DIR|DATA_DIR|ENV_FILE|KEY_FILE|SECRET_FILE|CONTAINER_NAME|IMAGE_TAG|REPOSITORY|GIT_REF)
        printf -v "$key" '%s' "$value" ;;
    esac
  done < "$file"
  [ -n "$TYPE" ] && [ -n "$PORT" ] && [ -n "$APP_DIR" ] && [ -n "$SOURCE_DIR" ] && [ -n "$CONTAINER_NAME" ]
}

discover_instances() {
  META_FILES=()
  local file seen='|'
  shopt -s nullglob
  for file in /opt/chat2api-*/.chat2api-deploy /opt/chat2api-py-upstream-*/.chat2api-deploy; do
    case "$seen" in *"|$file|"*) continue;; esac
    if load_meta "$file" && [[ "$TYPE" =~ ^(fork|py-upstream)$ ]] && [ "$SCHEMA_VERSION" = 2 ] && [ "$AUTH_MODE" = management-secret ]; then
      META_FILES+=("$file"); seen+="$file|"
    fi
  done
  shopt -u nullglob
  [ "${#META_FILES[@]}" -gt 0 ] || die "未发现新版 WebUI 部署实例。旧 Electron 实例不会由本脚本更新。"
}

show_instances() {
  local i file
  printf '%-4s %-24s %-8s %-16s %s\n' '编号' '项目名' '端口' '版本号' '项目目录'
  for i in "${!META_FILES[@]}"; do
    file="${META_FILES[$i]}"; load_meta "$file"
    printf '%-4s %-24s %-8s %-16s %s\n' "$((i+1))" "$PROJECT_NAME" "$PORT" "$VERSION" "$APP_DIR"
  done
}

select_instance() {
  local selection="${CHAT2API_SELECT:-}" file matched=''
  if [ -z "$selection" ]; then
    [ -r /dev/tty ] || die "无法读取交互终端；请设置 CHAT2API_SELECT 为编号或端口。"
    IFS= read -r -p "请输入编号或端口: " selection </dev/tty
  fi
  [[ "$selection" =~ ^[0-9]+$ ]] || die "请输入数字编号或端口。"
  if [ "$selection" -ge 1 ] && [ "$selection" -le "${#META_FILES[@]}" ]; then
    SELECTED_META="${META_FILES[$((selection-1))]}"; return
  fi
  for file in "${META_FILES[@]}"; do
    load_meta "$file"
    if [ "$PORT" = "$selection" ]; then [ -z "$matched" ] || die "端口 $selection 对应多个实例，请按编号选择。"; matched="$file"; fi
  done
  [ -n "$matched" ] || die "未找到编号或端口：$selection"
  SELECTED_META="$matched"
}

backup_persistent() {
  BACKUP_DIR="$APP_DIR/backups/update-$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -m 700 "$BACKUP_DIR"
  cp -a "$DATA_DIR" "$BACKUP_DIR/data"
  cp -a "$ENV_FILE" "$KEY_FILE" "$SECRET_FILE" "$SELECTED_META" "$BACKUP_DIR/"
}

verify_instance() {
  local i code key management_secret
  management_secret="$(<"$SECRET_FILE")"
  for i in $(seq 1 120); do
    curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" | python3 -c 'import json,sys; assert json.load(sys.stdin).get("status")=="running"' >/dev/null 2>&1 && break
    [ "$i" -lt 120 ] || return 1
    sleep 2
  done
  code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/admin/")"; [ "$code" = 200 ] || return 1
  code="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer invalid-management-secret' "http://127.0.0.1:$PORT/v0/management/health")"; [ "$code" = 401 ] || return 1
  code="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $management_secret" "http://127.0.0.1:$PORT/v0/management/health")"; [ "$code" = 200 ] || return 1
  code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/models")"; [ "$code" = 401 ] || return 1
  key="$(<"$KEY_FILE")"
  code="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" "http://127.0.0.1:$PORT/v1/models")"; [ "$code" = 200 ]
}

write_meta_version() {
  META_PATH="$SELECTED_META" NEW_VERSION="$NEW_VERSION" NEW_HEAD="$NEW_HEAD" NEW_IMAGE="$NEW_IMAGE" python3 - <<'PY'
import os
p=os.environ['META_PATH']; values={'VERSION':os.environ['NEW_VERSION'],'SOURCE_HEAD':os.environ['NEW_HEAD'],'IMAGE_TAG':os.environ['NEW_IMAGE']}
lines=open(p,encoding='utf-8').read().splitlines(); out=[]; seen=set()
for line in lines:
    key=line.split('=',1)[0]
    if key in values: out.append(f'{key}={values[key]}'); seen.add(key)
    else: out.append(line)
for key,value in values.items():
    if key not in seen: out.append(f'{key}={value}')
t=p+'.tmp'; open(t,'w',encoding='utf-8').write('\n'.join(out)+'\n'); os.replace(t,p)
PY
  chmod 600 "$SELECTED_META"
}

update_instance() {
  [ -d "$SOURCE_DIR/.git" ] || die "源码目录不是 Git 仓库：$SOURCE_DIR"
  [ -z "$(git -C "$SOURCE_DIR" status --porcelain --untracked-files=no)" ] || die "源码存在已跟踪修改，已停止更新。"
  OLD_HEAD="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
  OLD_IMAGE="$IMAGE_TAG"
  git -C "$SOURCE_DIR" fetch origin "refs/heads/$GIT_REF:refs/remotes/origin/$GIT_REF" --prune
  NEW_HEAD="$(git -C "$SOURCE_DIR" rev-parse "origin/$GIT_REF")"
  if [ "$OLD_HEAD" = "$NEW_HEAD" ]; then
    log "$PROJECT_NAME 已是最新版本 $VERSION。仍将重建并验收当前版本。"
  else
    git -C "$SOURCE_DIR" merge-base --is-ancestor "$OLD_HEAD" "$NEW_HEAD" || die "远程 main 不是当前版本的快进更新；请按维护文档处理分叉。"
    git -C "$SOURCE_DIR" merge --ff-only "$NEW_HEAD"
  fi
  NEW_VERSION="$(git -C "$SOURCE_DIR" rev-parse --short=12 HEAD)"
  NEW_IMAGE="chat2api-${TYPE}:${PORT}-${NEW_VERSION}"
  if ! docker build -t "$NEW_IMAGE" "$SOURCE_DIR"; then git -C "$SOURCE_DIR" reset --keep "$OLD_HEAD" || true; die "新镜像构建失败，源码已尝试回滚。"; fi

  docker stop -t 600 "$CONTAINER_NAME" >/dev/null || true
  docker rm "$CONTAINER_NAME" >/dev/null || true
  docker run -d --name "$CONTAINER_NAME" --restart unless-stopped --env-file "$ENV_FILE" -p "${PORT}:8080" -v "$DATA_DIR:/data" "$NEW_IMAGE" >/dev/null
  if ! verify_instance; then
    log "新版本验收失败，开始回滚。"
    docker logs --tail 150 "$CONTAINER_NAME" || true
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    rm -rf "$DATA_DIR"
    cp -a "$BACKUP_DIR/data" "$DATA_DIR"
    git -C "$SOURCE_DIR" reset --keep "$OLD_HEAD" || true
    docker run -d --name "$CONTAINER_NAME" --restart unless-stopped --env-file "$ENV_FILE" -p "${PORT}:8080" -v "$DATA_DIR:/data" "$OLD_IMAGE" >/dev/null
    verify_instance || die "新版本失败且旧版本恢复验收也失败，请检查 docker logs。"
    die "新版本验收失败，已恢复旧版本。"
  fi
  write_meta_version
  [ "$OLD_IMAGE" = "$NEW_IMAGE" ] || docker image rm "$OLD_IMAGE" >/dev/null 2>&1 || true
}

main() {
  require_root
  discover_instances
  show_instances
  select_instance
  load_meta "$SELECTED_META" || die "实例元数据损坏。"
  printf '\n将更新：%s，端口 %s，目录 %s\n' "$PROJECT_NAME" "$PORT" "$APP_DIR"
  backup_persistent
  update_instance
  verify_instance || die "更新后的最终验收失败。"
  printf '\n更新完成：%s %s\n端口：%s\n项目目录：%s\n备份目录：%s\n容器：%s\n' "$PROJECT_NAME" "$NEW_VERSION" "$PORT" "$APP_DIR" "$BACKUP_DIR" "$CONTAINER_NAME"
}
main "$@"
