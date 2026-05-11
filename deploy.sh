#!/bin/bash
# ==========================================================
# smanga 部署/升级脚本
# 1. 修改 docker-compose.yml 中的镜像版本号到目标版本
# 2. 重新拉取镜像并重建容器 (docker compose up -d)
# 3. 清理同名镜像中未被使用的旧版本，释放磁盘空间
#
# 使用方式:
#   ./deploy.sh                       使用脚本内默认变量
#   ./deploy.sh 1.2.3                 指定版本号
#   ./deploy.sh 1.2.3 /opt/smanga     指定版本号 + compose 目录
#   ./deploy.sh -v 1.2.3 -d /opt/smanga -f docker-compose.yml -i lkw199711/smanga-nodejs
# ==========================================================

# ---------- 默认配置 (可通过命令行参数覆盖) ----------
COMPOSE_DIR="/mnt/vdb/docker/smanga"
COMPOSE_FILE="docker-compose.yml"
IMAGE_NAME="lkw199711/smanga-nodejs"
IMAGE_VERSION="latest"

# ---------- 解析命令行参数 ----------
# 支持两种风格:
#   位置参数: deploy.sh <version> [compose_dir]
#   带选项:   -v <version> -d <dir> -f <file> -i <image>
POSITIONAL=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        -v|--version)
            IMAGE_VERSION="$2"; shift 2 ;;
        -d|--dir)
            COMPOSE_DIR="$2"; shift 2 ;;
        -f|--file)
            COMPOSE_FILE="$2"; shift 2 ;;
        -i|--image)
            IMAGE_NAME="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,15p' "$0"; exit 0 ;;
        --)
            shift; break ;;
        -*)
            echo "❌ 未知选项: $1"; exit 1 ;;
        *)
            POSITIONAL+=("$1"); shift ;;
    esac
done

# 处理位置参数
if [ ${#POSITIONAL[@]} -ge 1 ]; then
    IMAGE_VERSION="${POSITIONAL[0]}"
fi
if [ ${#POSITIONAL[@]} -ge 2 ]; then
    COMPOSE_DIR="${POSITIONAL[1]}"
fi

# ---------- 选择 docker compose 命令 ----------
if docker compose version >/dev/null 2>&1; then
    DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    DC="docker-compose"
else
    echo "❌ 未检测到 docker compose / docker-compose 命令"
    exit 1
fi

# ---------- 计时函数 ----------
time_start() { START_TIME=$(date +%s); }
time_end()   { END_TIME=$(date +%s); echo "⏱️  耗时: $((END_TIME - START_TIME)) 秒"; }
TOTAL_START=$(date +%s)

echo "========================================"
echo "smanga 部署/升级脚本"
echo "========================================"
echo "Compose 目录: ${COMPOSE_DIR}"
echo "Compose 文件: ${COMPOSE_FILE}"
echo "镜像名:       ${IMAGE_NAME}"
echo "目标版本:     ${IMAGE_VERSION}"
echo "Compose 命令: ${DC}"
echo "========================================"
echo ""

# ---------- 前置检查 ----------
COMPOSE_PATH="${COMPOSE_DIR}/${COMPOSE_FILE}"
if [ ! -f "${COMPOSE_PATH}" ]; then
    echo "❌ 找不到 compose 文件: ${COMPOSE_PATH}"
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "❌ Docker 服务异常"
    exit 1
fi

cd "${COMPOSE_DIR}" || { echo "❌ 无法进入目录: ${COMPOSE_DIR}"; exit 1; }

TARGET_IMAGE="${IMAGE_NAME}:${IMAGE_VERSION}"

# ---------- 步骤1: 修改 compose 文件中的镜像版本号 ----------
echo "[1/4] 修改 ${COMPOSE_FILE} 中 ${IMAGE_NAME} 的版本号..."
echo "----------------------------------------"

# 备份
BACKUP_PATH="${COMPOSE_PATH}.bak.$(date +%Y%m%d-%H%M%S)"
cp "${COMPOSE_PATH}" "${BACKUP_PATH}"
echo "已备份到: ${BACKUP_PATH}"

# 显示原 image 行
OLD_LINE=$(grep -E "^[[:space:]]*image:[[:space:]]*${IMAGE_NAME}:" "${COMPOSE_PATH}")
if [ -z "${OLD_LINE}" ]; then
    echo "❌ 在 ${COMPOSE_PATH} 中没找到镜像 ${IMAGE_NAME}: 的引用"
    exit 1
fi
echo "原镜像行:"
echo "${OLD_LINE}" | sed 's/^/    /'

# sed 替换: 把 "image: <IMAGE_NAME>:xxx" 替换为 "image: <IMAGE_NAME>:<VERSION>"
# 使用 | 作为分隔符避免 / 冲突
ESC_IMAGE=$(printf '%s\n' "${IMAGE_NAME}" | sed 's/[][\\/.^$*]/\\&/g')
sed -i -E "s|(^[[:space:]]*image:[[:space:]]*)${ESC_IMAGE}:[^[:space:]]+|\1${IMAGE_NAME}:${IMAGE_VERSION}|g" "${COMPOSE_PATH}"
SED_EXIT=$?

if [ ${SED_EXIT} -ne 0 ]; then
    echo "❌ 修改失败 (sed exit=${SED_EXIT})"
    exit 1
fi

NEW_LINE=$(grep -E "^[[:space:]]*image:[[:space:]]*${IMAGE_NAME}:" "${COMPOSE_PATH}")
echo "新镜像行:"
echo "${NEW_LINE}" | sed 's/^/    /'
echo "✅ 版本号已更新"
echo ""

# ---------- 步骤2: 拉取镜像 ----------
echo "[2/4] 拉取镜像 ${TARGET_IMAGE}..."
echo "----------------------------------------"
time_start
docker pull "${TARGET_IMAGE}"
PULL_EXIT=$?
time_end

if [ ${PULL_EXIT} -ne 0 ]; then
    echo "❌ 拉取镜像失败 (exit=${PULL_EXIT})，已回滚 compose 文件"
    cp "${BACKUP_PATH}" "${COMPOSE_PATH}"
    exit 1
fi
echo "✅ 镜像拉取成功"
echo ""

# ---------- 步骤3: 重建容器 ----------
echo "[3/4] 重建容器 (${DC} up -d)..."
echo "----------------------------------------"
time_start
${DC} -f "${COMPOSE_FILE}" up -d
UP_EXIT=$?
time_end

if [ ${UP_EXIT} -ne 0 ]; then
    echo "❌ 容器启动失败 (exit=${UP_EXIT})"
    exit 1
fi
echo "✅ 容器已更新启动"
echo ""

# ---------- 步骤4: 清理未使用的旧版本镜像 ----------
echo "[4/4] 清理 ${IMAGE_NAME} 的旧版本镜像..."
echo "----------------------------------------"

# 获取该镜像名下所有的 image id + tag
ALL_IMAGES=$(docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' \
    | awk -v img="${IMAGE_NAME}" '$1 ~ "^"img":" {print $0}')

if [ -z "${ALL_IMAGES}" ]; then
    echo "未发现 ${IMAGE_NAME} 的本地镜像"
else
    # 当前正在使用的 image id 集合 (所有容器，不止运行中的)
    INUSE_IDS=$(docker ps -a --format '{{.Image}} {{.ImageID}}' \
        | awk '{print $2}' | sed 's/^sha256://' | sort -u)

    REMOVED=0
    SKIPPED=0
    while IFS= read -r line; do
        [ -z "${line}" ] && continue
        REPO_TAG=$(echo "${line}" | awk '{print $1}')
        IMG_ID=$(echo "${line}" | awk '{print $2}')
        SHORT_ID=$(echo "${IMG_ID}" | cut -c1-12)

        # 跳过当前目标镜像
        if [ "${REPO_TAG}" = "${TARGET_IMAGE}" ]; then
            echo "  ⏭️  保留当前版本: ${REPO_TAG}"
            SKIPPED=$((SKIPPED + 1))
            continue
        fi

        # 跳过正在被容器使用的镜像 (用 image id 比对，兼容短/长 id)
        IN_USE=false
        for uid in ${INUSE_IDS}; do
            uid_short=$(echo "${uid}" | cut -c1-12)
            if [ "${uid_short}" = "${SHORT_ID}" ]; then
                IN_USE=true
                break
            fi
        done

        if [ "${IN_USE}" = "true" ]; then
            echo "  ⏭️  保留使用中: ${REPO_TAG} (${SHORT_ID})"
            SKIPPED=$((SKIPPED + 1))
            continue
        fi

        echo "  🗑️  删除: ${REPO_TAG} (${SHORT_ID})"
        if docker rmi "${REPO_TAG}" >/dev/null 2>&1; then
            REMOVED=$((REMOVED + 1))
        else
            # 如果按 tag 删失败 (例如多 tag 共用)，尝试按 id 删
            docker rmi "${IMG_ID}" >/dev/null 2>&1 && REMOVED=$((REMOVED + 1)) \
                || echo "     ⚠️  删除失败，可能仍有 tag 引用"
        fi
    done <<< "${ALL_IMAGES}"

    echo ""
    echo "清理结果: 删除 ${REMOVED} 个，保留 ${SKIPPED} 个"
fi
echo "✅ 旧镜像清理完成"
echo ""

# ---------- 总结 ----------
TOTAL_END=$(date +%s)
TOTAL_DURATION=$((TOTAL_END - TOTAL_START))

echo "========================================"
echo "🎉 部署完成!"
echo "========================================"
echo "总耗时:   ${TOTAL_DURATION} 秒"
echo "目标镜像: ${TARGET_IMAGE}"
echo "Compose:  ${COMPOSE_PATH}"
echo "备份文件: ${BACKUP_PATH}"
echo ""
echo "查看容器状态:"
echo "  cd ${COMPOSE_DIR} && ${DC} ps"
echo "查看日志:"
echo "  cd ${COMPOSE_DIR} && ${DC} logs -f"
echo "========================================"