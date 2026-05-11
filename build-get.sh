#!/bin/bash
# ==========================================================
# smanga-get 镜像构建脚本
# 基于 Dockerfile.get，打包 smanga-get + smanga-get-webui
# 参考: build.sh 的分步骤 / 计时 / 推送结构
# ==========================================================

# 配置
DOCKER_USERNAME="${DOCKER_USERNAME:-lkw199711}"
DOCKER_PASSWORD="${DOCKER_PASSWORD:-123qwe123}"
IMAGE_NAME="${DOCKER_USERNAME}/smanga-get"
TIMEOUT=2000  # 单步骤超时时间(秒)

# 获取脚本目录 (版本号将在 git pull 之后读取，确保拿到最新版本)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
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

# 带超时执行
run_with_timeout() {
    timeout ${TIMEOUT} "$@"
    return $?
}

# 总结统计
TOTAL_START=$(date +%s)

echo "========================================"
echo "smanga-get 镜像构建脚本"
echo "========================================"
echo "镜像名:    ${IMAGE_NAME} (版本号将在拉取最新代码后确定)"
echo "脚本目录:  ${SCRIPT_DIR}"
echo "单步超时:  ${TIMEOUT} 秒"
echo "========================================"
echo ""

# 步骤1: 更新项目代码
echo "[1/6] 更新项目代码..."
echo "----------------------------------------"
time_start

# 更新 smanga-get 后端项目
echo "更新 smanga-get 项目..."
cd "${SCRIPT_DIR}/smanga-get"
run_with_timeout git pull
GET_UPDATE_EXIT=$?

# 更新 smanga-get-webui 前端项目
echo "更新 smanga-get-webui 项目..."
cd "${SCRIPT_DIR}/smanga-get-webui"
run_with_timeout git pull
WEBUI_UPDATE_EXIT=$?

# 返回脚本目录
cd "${SCRIPT_DIR}"

time_end

if [ $GET_UPDATE_EXIT -ne 0 ]; then
    echo "❌ smanga-get 项目更新失败 (exit=$GET_UPDATE_EXIT)"
    exit 1
fi

if [ $WEBUI_UPDATE_EXIT -ne 0 ]; then
    echo "❌ smanga-get-webui 项目更新失败 (exit=$WEBUI_UPDATE_EXIT)"
    exit 1
fi

echo "✅ 项目代码更新成功"

# 拉取最新代码后再读取版本号，避免使用旧版本号打 tag
VERSION=$(grep '"version"' "${SCRIPT_DIR}/smanga-get/package.json" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
if [ -z "${VERSION}" ] || [ "${VERSION}" = "0.0.0" ]; then
    VERSION="$(date +%Y%m%d-%H%M%S)"
    echo "⚠️  package.json 未提供有效版本号，使用时间戳: ${VERSION}"
fi
echo "📦 当前版本号: ${VERSION}"
echo "🐳 目标镜像:   ${IMAGE_NAME}:${VERSION}"
echo ""

# 步骤2: 检测 Docker Hub 连接
echo "[2/6] 检测网络环境..."
echo "----------------------------------------"
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

# 步骤3: 检查 Docker
echo "[3/6] 检查 Docker 服务..."
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
echo "[4/6] 登录 Docker Hub..."
echo "----------------------------------------"
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

# 步骤5: 构建镜像
echo "[5/6] 构建镜像..."
echo "----------------------------------------"
echo "命令: docker build -f Dockerfile.get -t ${IMAGE_NAME}:${VERSION} ${SCRIPT_DIR}"
echo ""
time_start
run_with_timeout docker build \
    -f "${SCRIPT_DIR}/Dockerfile.get" \
    -t "${IMAGE_NAME}:${VERSION}" \
    -t "${IMAGE_NAME}:latest" \
    "${SCRIPT_DIR}"
BUILD_EXIT=$?
time_end

if [ $BUILD_EXIT -ne 0 ]; then
    echo "❌ 构建失败! (exit=$BUILD_EXIT)"
    exit 1
fi
echo "✅ 构建成功"
echo ""

# 步骤6: 推送镜像
echo "[6/6] 推送镜像到 Docker Hub..."
echo "----------------------------------------"
time_start
run_with_timeout docker push "${IMAGE_NAME}:${VERSION}"
PUSH_V_EXIT=$?
time_end

if [ $PUSH_V_EXIT -ne 0 ]; then
    echo "❌ 推送 ${VERSION} 失败! (exit=$PUSH_V_EXIT)"
    exit 1
fi

echo "推送 latest 标签..."
time_start
run_with_timeout docker push "${IMAGE_NAME}:latest"
PUSH_L_EXIT=$?
time_end

if [ $PUSH_L_EXIT -ne 0 ]; then
    echo "❌ 推送 latest 失败! (exit=$PUSH_L_EXIT)"
    exit 1
fi
echo "✅ 推送成功"
echo ""

# 删除本地镜像，释放磁盘空间
echo "🧹 删除本地镜像..."
echo "----------------------------------------"
docker rmi "${IMAGE_NAME}:${VERSION}" 2>/dev/null && echo "已删除: ${IMAGE_NAME}:${VERSION}"
docker rmi "${IMAGE_NAME}:latest" 2>/dev/null && echo "已删除: ${IMAGE_NAME}:latest"
echo "✅ 本地镜像清理完成"
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
echo "  - ${IMAGE_NAME}:${VERSION}"
echo "  - ${IMAGE_NAME}:latest"
echo ""
echo "运行示例:"
echo "  docker run -d --name smanga-get \\"
echo "    -p 9799:9799 -p 9800:9800 \\"
echo "    -v \$(pwd)/data:/data \\"
echo "    ${IMAGE_NAME}:${VERSION}"
echo "========================================"