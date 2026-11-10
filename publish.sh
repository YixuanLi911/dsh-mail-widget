#!/bin/bash
# 发布 dsh-plugin-mail-widget 到 npm
# 用法：在“终端”里执行  ./publish.sh
set -euo pipefail
cd "$(dirname "$0")"

NODE="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
PNPM="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs"

if [ ! -x "$NODE" ]; then
  echo "找不到 Node 运行时：$NODE"
  exit 1
fi

NAME=$(python3 -c "import json;print(json.load(open('package.json'))['name'])")
VERSION=$(python3 -c "import json;print(json.load(open('package.json'))['version'])")

echo "包名：$NAME"
echo "版本：$VERSION"

# 1) 检查登录凭据
if ! grep -qs "_authToken\|_auth" "$HOME/.npmrc"; then
  cat <<'EOF'

还没有配置 npm 登录凭据。先在浏览器里做一次：

  1. 打开 https://www.npmjs.com/ 并登录
  2. 右上角头像 → Access Tokens → Generate New Token
     - 选择 Classic Token
     - 类型选 Automation（这样发布不需要每次输验证码）
  3. 复制生成的 token（形如 npm_xxxxxxxx，只显示一次）

然后在“终端”里执行（把 npm_xxx 换成你的 token）：

  echo '//registry.npmjs.org/:_authToken=npm_xxx' >> ~/.npmrc
  chmod 600 ~/.npmrc

配置好后再运行一次 ./publish.sh

EOF
  exit 1
fi

# 2) 检查包名是否已被占用（404 = 可用）
echo
echo "==> 检查包名"
if "$NODE" "$PNPM" view "$NAME" version >/dev/null 2>&1; then
  echo "⚠️  $NAME 已经存在于 npm（可能是你自己的旧版本）。"
  echo "    如果这是首次发布，说明名字被别人占了，需要改 package.json 里的 name。"
  echo "    如果是升级：确认 package.json 的 version 已改成新版本（$VERSION 若已存在会发布失败）。"
fi

# 3) 打包预览
echo
echo "==> 将要发布的文件"
"$NODE" "$PNPM" pack --pack-destination /tmp >/dev/null
tar -tzf "/tmp/$NAME-$VERSION.tgz" | sed 's/^/    /'
rm -f "/tmp/$NAME-$VERSION.tgz"

# 4) 发布
echo
echo "==> 发布中…（首次发布会问你要不要继续，输入 y 回车）"
"$NODE" "$PNPM" publish --access public --no-git-checks

echo
echo "✅ 发布完成。一分钟后看："
echo "   https://www.npmjs.com/package/$NAME"
echo
echo "接下来可以让别人安装："
echo "   dsh plugin --profile <profile> add $NAME"
