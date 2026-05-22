#!/bin/bash

# smanga AMD64 镜像构建脚本 (简化版 - 使用默认构建环境)
# 参考: smanga/.github/workflows/docker.yml

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
PUSH_TO_DOCKERHUB=true
PUSH_TO_ALIYUN=false

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
echo "Smanga AMD64 镜像构建脚本 (简化版)"
echo "========================================"
echo "镜像名: ${IMAGE_NAME} (版本号将在拉取最新代码后确定)"
echo "平台: linux/amd64 (当前主机架构)"
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

# 步骤2: 检测 Docker Hub 连接
echo "[2/7] 检测网络环境..."
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

# 步骤3: 检查 Docker
echo "[3/7] 检查 Docker 服务..."
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

# 步骤4: 登录 Docker Hub
echo "[4/7] 登录 Docker Hub..."
echo "----------------------------------------"
if [ "${PUSH_TO_DOCKERHUB}" != "true" ]; then
    echo "⏭️  已关闭 Docker Hub 推送，跳过登录"
    echo ""
else
time_start
echo "${DOCKER_PASSWORD}" | docker login -u "${DOCKER_USERNAME}" --password-stdin
LOGIN_EXIT=$?
time_end

if [ $LOGIN_EXIT -ne 0 ]; then
    echo "❌ Docker Hub 登录失败"
    exit 1
fi
echo "✅ 登录成功"
echo ""
fi

# 步骤5: 构建镜像 (使用默认环境，利用本地缓存)
echo "[5/7] 构建 AMD64 镜像..."
echo "----------------------------------------"
echo "命令: docker build -t ${IMAGE_NAME}:${VERSION} ${SCRIPT_DIR}"
echo ""
time_start
docker build \
  -t "${IMAGE_NAME}:${VERSION}" \
  -t "${IMAGE_NAME}:latest" \
  "${SCRIPT_DIR}"
BUILD_EXIT=$?
time_end

if [ $BUILD_EXIT -ne 0 ]; then
    echo "❌ 构建失败!"
    exit 1
fi
echo "✅ 构建成功"
echo ""

# 步骤6: 推送镜像
echo "[6/7] 推送镜像到 Docker Hub..."
echo "----------------------------------------"
if [ "${PUSH_TO_DOCKERHUB}" != "true" ]; then
    echo "⏭️  已关闭 Docker Hub 推送，跳过本步骤"
    echo ""
else
time_start
docker push "${IMAGE_NAME}:${VERSION}"
PUSH_V_EXIT=$?
time_end

if [ $PUSH_V_EXIT -ne 0 ]; then
    echo "❌ 推送失败!"
    exit 1
fi

echo "推送 latest 标签..."
time_start
docker push "${IMAGE_NAME}:latest"
PUSH_L_EXIT=$?
time_end

if [ $PUSH_L_EXIT -ne 0 ]; then
    echo "❌ 推送 latest 失败!"
    exit 1
fi
echo "✅ 推送成功"
echo ""
fi

# 步骤7: 推送镜像到阿里云镜像仓库
echo "[7/7] 推送镜像到阿里云镜像仓库..."
echo "----------------------------------------"
if [ "${PUSH_TO_ALIYUN}" != "true" ]; then
    echo "⏭️  已关闭 阿里云 推送，跳过本步骤"
    echo ""
else
echo "目标仓库: ${ALIYUN_IMAGE_NAME}"

# 7.1 登录阿里云镜像仓库
echo "登录 ${ALIYUN_REGISTRY} ..."
time_start
echo "${ALIYUN_PASSWORD}" | docker login -u "${ALIYUN_USERNAME}" --password-stdin "${ALIYUN_REGISTRY}"
ALIYUN_LOGIN_EXIT=$?
time_end

if [ $ALIYUN_LOGIN_EXIT -ne 0 ]; then
    echo "❌ 阿里云镜像仓库登录失败"
    exit 1
fi
echo "✅ 阿里云登录成功"

# 7.2 给镜像打阿里云 tag
echo "为镜像打 tag: ${ALIYUN_IMAGE_NAME}:${VERSION} / :latest"
docker tag "${IMAGE_NAME}:${VERSION}" "${ALIYUN_IMAGE_NAME}:${VERSION}"
TAG_V_EXIT=$?
docker tag "${IMAGE_NAME}:latest" "${ALIYUN_IMAGE_NAME}:latest"
TAG_L_EXIT=$?

if [ $TAG_V_EXIT -ne 0 ] || [ $TAG_L_EXIT -ne 0 ]; then
    echo "❌ 阿里云镜像打 tag 失败"
    exit 1
fi

# 7.3 推送版本号 tag
echo "推送 ${ALIYUN_IMAGE_NAME}:${VERSION} ..."
time_start
docker push "${ALIYUN_IMAGE_NAME}:${VERSION}"
ALIYUN_PUSH_V_EXIT=$?
time_end

if [ $ALIYUN_PUSH_V_EXIT -ne 0 ]; then
    echo "❌ 阿里云推送版本号失败!"
    exit 1
fi

# 7.4 推送 latest tag
echo "推送 ${ALIYUN_IMAGE_NAME}:latest ..."
time_start
docker push "${ALIYUN_IMAGE_NAME}:latest"
ALIYUN_PUSH_L_EXIT=$?
time_end

if [ $ALIYUN_PUSH_L_EXIT -ne 0 ]; then
    echo "❌ 阿里云推送 latest 失败!"
    exit 1
fi
echo "✅ 阿里云镜像推送成功"
echo ""
fi

# 删除本地镜像，释放磁盘空间
echo "🧹 删除本地镜像..."
echo "----------------------------------------"
docker rmi "${IMAGE_NAME}:${VERSION}" 2>/dev/null && echo "已删除: ${IMAGE_NAME}:${VERSION}"
docker rmi "${IMAGE_NAME}:latest" 2>/dev/null && echo "已删除: ${IMAGE_NAME}:latest"
if [ "${PUSH_TO_ALIYUN}" = "true" ]; then
    docker rmi "${ALIYUN_IMAGE_NAME}:${VERSION}" 2>/dev/null && echo "已删除: ${ALIYUN_IMAGE_NAME}:${VERSION}"
    docker rmi "${ALIYUN_IMAGE_NAME}:latest" 2>/dev/null && echo "已删除: ${ALIYUN_IMAGE_NAME}:latest"
fi
echo "✅ 本地镜像清理完成"
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
echo "🎉 构建完成!"
echo "========================================"
echo "总耗时: ${TOTAL_DURATION} 秒"
echo ""
echo "镜像已推送:"
if [ "${PUSH_TO_DOCKERHUB}" = "true" ]; then
    echo "  - ${IMAGE_NAME}:${VERSION}"
    echo "  - ${IMAGE_NAME}:latest"
else
    echo "  - (已跳过 Docker Hub 推送)"
fi
if [ "${PUSH_TO_ALIYUN}" = "true" ]; then
    echo "  - ${ALIYUN_IMAGE_NAME}:${VERSION}"
    echo "  - ${ALIYUN_IMAGE_NAME}:latest"
else
    echo "  - (已跳过 阿里云 推送)"
fi
echo "========================================"
