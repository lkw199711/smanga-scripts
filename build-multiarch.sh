#!/bin/bash

# smanga 多架构镜像构建脚本 (amd64 + arm64)
# 使用 docker buildx 实现跨平台构建
# 参考: smanga-scripts/build.sh

# 配置
DOCKER_USERNAME="lkw199711"
DOCKER_PASSWORD="123qwe123"
IMAGE_NAME="${DOCKER_USERNAME}/smanga-nodejs"
TIMEOUT=2000  # 单步骤超时时间(秒)

# 阿里云镜像仓库配置
ALIYUN_REGISTRY="registry.cn-hangzhou.aliyuncs.com"
ALIYUN_NAMESPACE="lkw199711"
ALIYUN_USERNAME="15369811135"
ALIYUN_PASSWORD='123qweQA!'
ALIYUN_IMAGE_NAME="${ALIYUN_REGISTRY}/${ALIYUN_NAMESPACE}/smanga-nodejs"

# 推送开关 (true=推送, false=跳过)
PUSH_TO_DOCKERHUB=false
PUSH_TO_ALIYUN=true

# 多架构配置
BUILDER_NAME="multiarch"
PLATFORMS="linux/amd64,linux/arm64"

# 获取脚本目录 (版本号将在 git pull 之后读取，确保拿到最新版本)
# SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_DIR="/smanga"
VERSION=""

# 计时函数
time_start() {
    START_TIME=$(date +%s)
}

time_end() {
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
    echo "⏱️  耗时: ${DURATION} 秒"
}

# 总结统计
TOTAL_START=$(date +%s)

echo "========================================"
echo "Smanga 多架构镜像构建脚本 (buildx)"
echo "========================================"
echo "镜像名: ${IMAGE_NAME} (版本号将在拉取最新代码后确定)"
echo "平台: ${PLATFORMS}"
echo "单步超时: ${TIMEOUT} 秒"
echo "推送 Docker Hub: ${PUSH_TO_DOCKERHUB}"
echo "推送 阿里云   : ${PUSH_TO_ALIYUN}"
echo "========================================"
echo ""

# 步骤1: 更新项目代码
echo "[1/7] 更新项目代码..."
echo "----------------------------------------"
time_start

# 更新smanga项目
echo "更新 smanga 项目..."
cd "${SCRIPT_DIR}/smanga"
git pull origin electron
SMANGA_UPDATE_EXIT=$?

# 更新smanga-adonis项目
echo "更新 smanga-adonis 项目..."
cd "${SCRIPT_DIR}/smanga-adonis"
git pull origin main
ADONIS_UPDATE_EXIT=$?

# 返回脚本目录
cd "${SCRIPT_DIR}"

time_end

if [ $SMANGA_UPDATE_EXIT -ne 0 ]; then
    echo "❌ smanga 项目更新失败"
    exit 1
fi

if [ $ADONIS_UPDATE_EXIT -ne 0 ]; then
    echo "❌ smanga-adonis 项目更新失败"
    exit 1
fi

echo "✅ 项目代码更新成功"

# 拉取最新代码后再读取版本号，避免使用旧版本号打 tag
VERSION=$(grep '"version"' "${SCRIPT_DIR}/smanga/package.json" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
if [ -z "${VERSION}" ]; then
    echo "❌ 无法从 smanga/package.json 读取版本号"
    exit 1
fi
echo "📦 当前版本号: ${VERSION}"
echo "🐳 目标镜像:   ${IMAGE_NAME}:${VERSION}"
echo ""

# 步骤2: 确保 buildx builder 可用
echo "[2/7] 检查 buildx builder..."
echo "----------------------------------------"
time_start

if docker buildx inspect "${BUILDER_NAME}" > /dev/null 2>&1; then
    echo "✅ builder '${BUILDER_NAME}' 已存在"
    docker buildx use "${BUILDER_NAME}"
else
    echo "⚠️  builder '${BUILDER_NAME}' 不存在，正在创建..."
    docker buildx create --name "${BUILDER_NAME}" --driver docker-container --use
    if [ $? -ne 0 ]; then
        echo "❌ builder 创建失败"
        exit 1
    fi
    echo "✅ builder '${BUILDER_NAME}' 创建成功"
fi

echo "启动 builder..."
docker buildx inspect --bootstrap
echo ""
echo "已支持的平台:"
docker buildx inspect --builder "${BUILDER_NAME}" | grep -i platforms || echo "  (无法获取平台列表)"

time_end
echo ""

# 步骤3: 检测网络环境（仅当需要推送 Docker Hub 时）
echo "[3/7] 检测网络环境..."
echo "----------------------------------------"
if [ "${PUSH_TO_DOCKERHUB}" != "true" ]; then
    echo "⏭️  已关闭 Docker Hub 推送，跳过 Docker Hub 网络检测"
    echo ""
else
time_start
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 https://registry-1.docker.io/v2/ 2>&1)
CURL_EXIT=$?
time_end

if [ $CURL_EXIT -ne 0 ]; then
    echo "❌ 无法连接到 Docker Hub"
    echo "   请检查网络或配置 Docker daemon 代理"
    exit 1
fi

if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Docker Hub 连接正常 (HTTP $HTTP_CODE)"
else
    echo "⚠️  Docker Hub 返回 HTTP $HTTP_CODE，继续尝试..."
fi
echo ""
fi

# 步骤4: 检查 Docker
echo "[4/7] 检查 Docker 服务..."
echo "----------------------------------------"
time_start
docker info > /dev/null 2>&1
DOCKER_EXIT=$?
time_end

if [ $DOCKER_EXIT -ne 0 ]; then
    echo "❌ Docker 服务异常"
    exit 1
fi
echo "✅ Docker 服务正常"
echo ""

# 步骤5: 登录镜像仓库
echo "[5/7] 登录镜像仓库..."
echo "----------------------------------------"
time_start

# 登录 Docker Hub
if [ "${PUSH_TO_DOCKERHUB}" = "true" ]; then
    echo "登录 Docker Hub..."
    echo "${DOCKER_PASSWORD}" | docker login -u "${DOCKER_USERNAME}" --password-stdin
    if [ $? -ne 0 ]; then
        echo "❌ Docker Hub 登录失败"
        exit 1
    fi
    echo "✅ Docker Hub 登录成功"
else
    echo "⏭️  已关闭 Docker Hub 推送，跳过 Docker Hub 登录"
fi

# 登录阿里云
if [ "${PUSH_TO_ALIYUN}" = "true" ]; then
    echo "登录阿里云镜像仓库 (${ALIYUN_REGISTRY}) ..."
    echo "${ALIYUN_PASSWORD}" | docker login -u "${ALIYUN_USERNAME}" --password-stdin "${ALIYUN_REGISTRY}"
    if [ $? -ne 0 ]; then
        echo "❌ 阿里云镜像仓库登录失败"
        exit 1
    fi
    echo "✅ 阿里云登录成功"
else
    echo "⏭️  已关闭 阿里云 推送，跳过阿里云登录"
fi

time_end
echo ""

# 步骤6: 构建并推送多架构镜像
echo "[6/7] 构建并推送多架构镜像..."
echo "----------------------------------------"
echo "目标平台: ${PLATFORMS}"

# 动态组装 tag 列表
TAG_ARGS=""
TAG_LIST=""

if [ "${PUSH_TO_DOCKERHUB}" = "true" ]; then
    TAG_ARGS="${TAG_ARGS} -t ${IMAGE_NAME}:${VERSION} -t ${IMAGE_NAME}:latest"
    TAG_LIST="${TAG_LIST}  - ${IMAGE_NAME}:${VERSION}\n  - ${IMAGE_NAME}:latest\n"
fi

if [ "${PUSH_TO_ALIYUN}" = "true" ]; then
    TAG_ARGS="${TAG_ARGS} -t ${ALIYUN_IMAGE_NAME}:${VERSION} -t ${ALIYUN_IMAGE_NAME}:latest"
    TAG_LIST="${TAG_LIST}  - ${ALIYUN_IMAGE_NAME}:${VERSION}\n  - ${ALIYUN_IMAGE_NAME}:latest\n"
fi

if [ -z "${TAG_ARGS}" ]; then
    echo "❌ 未启用任何推送目标，无法构建（多架构构建必须推送）"
    exit 1
fi

echo ""
echo "推送目标:"
echo -e "${TAG_LIST}"

time_start
# docker buildx build 一次构建、同时推送到多个仓库
# 注意: --push 模式下不在本地保留镜像，直接推送到远程仓库
docker buildx build \
    --builder "${BUILDER_NAME}" \
    --platform "${PLATFORMS}" \
    ${TAG_ARGS} \
    --push \
    "${SCRIPT_DIR}"
BUILD_EXIT=$?
time_end

if [ $BUILD_EXIT -ne 0 ]; then
    echo "❌ 构建或推送失败!"
    exit 1
fi
echo "✅ 多架构镜像构建并推送成功"
echo ""

# 步骤7: 清理 buildx 构建缓存
echo "[7/7] 清理构建缓存..."
echo "----------------------------------------"
time_start

echo "当前 buildx 磁盘使用:"
docker buildx du --builder "${BUILDER_NAME}"

# 清理超过 72 小时的构建缓存
docker buildx prune --builder "${BUILDER_NAME}" --filter "until=72h" --force
echo "✅ buildx 缓存清理完成"

time_end
echo ""

# 收尾步骤: 检测剩余空间,低于阈值则清理 Docker 构建缓存
echo "🧹 检测磁盘空间..."
echo "----------------------------------------"
DISK_THRESHOLD_GB=2

# 取脚本所在分区的剩余空间(GB),兼容 GNU/BSD df
get_free_gb() {
    df -BG "${SCRIPT_DIR}" 2>/dev/null | awk 'NR==2 {gsub("G","",$4); print $4+0}' \
        || df -g "${SCRIPT_DIR}" 2>/dev/null | awk 'NR==2 {print $4+0}'
}

FREE_GB=$(get_free_gb)
echo "当前剩余空间: ${FREE_GB} GB (阈值: ${DISK_THRESHOLD_GB} GB)"

if [ -n "${FREE_GB}" ] && [ "${FREE_GB}" -lt "${DISK_THRESHOLD_GB}" ]; then
    echo "⚠️  剩余空间不足,清理 Docker 构建缓存..."
    time_start
    docker builder prune -af >/dev/null 2>&1
    docker system prune -f >/dev/null 2>&1
    time_end
    FREE_GB_AFTER=$(get_free_gb)
    echo "✅ 清理完成,剩余空间: ${FREE_GB_AFTER} GB"
else
    echo "✅ 剩余空间充足,跳过缓存清理"
fi
echo ""

# 总结

TOTAL_END=$(date +%s)
TOTAL_DURATION=$((TOTAL_END - TOTAL_START))

echo "========================================"
echo "🎉 多架构构建完成!"
echo "========================================"
echo "总耗时: ${TOTAL_DURATION} 秒"
echo ""
echo "已推送镜像:"
if [ "${PUSH_TO_DOCKERHUB}" = "true" ]; then
    echo "  - ${IMAGE_NAME}:${VERSION}     (${PLATFORMS})"
    echo "  - ${IMAGE_NAME}:latest         (${PLATFORMS})"
else
    echo "  - (已跳过 Docker Hub 推送)"
fi
if [ "${PUSH_TO_ALIYUN}" = "true" ]; then
    echo "  - ${ALIYUN_IMAGE_NAME}:${VERSION}  (${PLATFORMS})"
    echo "  - ${ALIYUN_IMAGE_NAME}:latest      (${PLATFORMS})"
else
    echo "  - (已跳过 阿里云 推送)"
fi
echo "========================================"
