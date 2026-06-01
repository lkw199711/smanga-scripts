# PowerShell script to merge subscription proxies into one config
$ErrorActionPreference = "Stop"
$base = "d:\15dev\smanga\smanga-scripts\clash"
$subDir = "$base\subscriptions"

# Read template for settings sections
$template = Get-Content "$base\template.yaml" -Raw -Encoding UTF8

# Function: extract proxies from a file, filter out info nodes
function Get-Proxies {
    param([string]$filePath, [string]$providerTag)
    
    $content = Get-Content $filePath -Raw -Encoding UTF8
    $lines = $content -split "`r?`n"
    
    $inProxies = $false
    $proxies = @()
    $infoKeywords = @("流量", "到期", "看不到节点", "官网")
    
    foreach ($line in $lines) {
        if ($line -match '^proxies:') {
            $inProxies = $true
            continue
        }
        if ($inProxies) {
            if ($line -match '^proxy-groups:' -or $line -match '^rules:' -or $line -match '^rule-providers:') {
                break
            }
            if ($line -match '^\s*-\s*\{') {
                # Extract proxy info
                $isInfo = $false
                foreach ($kw in $infoKeywords) {
                    if ($line -match $kw) { $isInfo = $true; break }
                }
                if (-not $isInfo) {
                    # Clean up the line: remove leading whitespace and dash
                    $cleanLine = $line -replace '^\s*-\s*', ''
                    # Add provider tag to name for identification
                    $proxies += @{ line = $cleanLine; name = ($line -replace '.*?name:\s*([^,}]+).*', '$1').Trim().Trim("'").Trim("'"); rawLine = $line }
                }
            }
        }
    }
    return $proxies
}

# Function: classify node by name
function Get-Region {
    param([string]$name)
    if ($name -match '香港|HK|hk') { return "hk" }
    if ($name -match '日本|JP|jp|软银') { return "jp" }
    if ($name -match '美国|US|us|美国家宽') { return "us" }
    if ($name -match '新加坡|SG|sg') { return "sg" }
    if ($name -match '台湾|TW|tw') { return "tw" }
    if ($name -match '德国|DE|de|英国|UK|uk|法国|FR|fr|荷兰|NL|nl|俄罗斯|RU|ru') { return "eu" }
    if ($name -match '越南|VN|vn|加拿大|CA|ca|尼日利亚|NG|ng|印度|IN|in') { return "other" }
    return "other"
}

# Extract proxies from all three files
$naiyunProxies = Get-Proxies "$subDir\奶云.yaml" "奶云"
$taoluProxies = Get-Proxies "$subDir\套路云.yaml" "套路云"
$mixueProxies = Get-Proxies "$subDir\蜜雪冰城.yaml" "蜜雪"

Write-Host "奶云节点: $($naiyunProxies.Count)"
Write-Host "套路云节点: $($taoluProxies.Count)"
Write-Host "蜜雪冰城节点: $($mixueProxies.Count)"
Write-Host "总计: $($naiyunProxies.Count + $taoluProxies.Count + $mixueProxies.Count)"

# Merge and categorize
$allProxies = @()
$regions = @{ hk = @(); jp = @(); us = @(); sg = @(); tw = @(); eu = @(); other = @() }

foreach ($p in ($naiyunProxies + $taoluProxies + $mixueProxies)) {
    $region = Get-Region $p.name
    $regions[$region] += $p
    $allProxies += $p
}

$regionNames = @{ 
    hk = "香港"; jp = "日本"; us = "美国"; sg = "新加坡"
    tw = "台湾"; eu = "欧洲"; other = "其他"
}
$regionEmojis = @{
    hk = "🇭🇰"; jp = "🇯🇵"; us = "🇺🇲"; sg = "🇸🇬"
    tw = "🇹🇼"; eu = "🇪🇺"; other = "🌍"
}

foreach ($key in @("hk","jp","us","sg","tw","eu","other")) {
    Write-Host "  $($regionEmojis[$key]) $($regionNames[$key]): $($regions[$key].Count) 个节点"
}

# Now generate the output file
$output = @()

# Header
$output += "# =========================================================="
$output += "# 合并配置：奶云 + 套路云 + 蜜雪冰城"
$output += "# 分组/规则来自 template.yaml"
$output += "# =========================================================="
$output += "mixed-port: 7890"
$output += "allow-lan: true"
$output += "bind-address: '*'"
$output += "mode: rule"
$output += "log-level: info"
$output += "external-controller: '127.0.0.1:9090'"
$output += "unified-delay: true"
$output += "tcp-concurrent: true"
$output += "global-client-fingerprint: chrome"
$output += ""

# DNS
$output += "dns:"
$output += "  enable: true"
$output += "  ipv6: false"
$output += "  enhanced-mode: fake-ip"
$output += "  fake-ip-range: 198.18.0.1/16"
$output += "  listen: 0.0.0.0:7874"
$output += "  use-hosts: true"
$output += "  respect-rules: true"
$output += ""
$output += "  default-nameserver:"
$output += "    - 223.5.5.5"
$output += "    - 119.29.29.29"
$output += "    - 114.114.114.114"
$output += ""
$output += "  nameserver:"
$output += "    - https://dns.alidns.com/dns-query"
$output += "    - https://doh.pub/dns-query"
$output += ""
$output += "  proxy-server-nameserver:"
$output += "    - https://dns.alidns.com/dns-query"
$output += "    - https://doh.pub/dns-query"
$output += ""
$output += "  fallback:"
$output += "    - https://dns.google/dns-query#🚀 默认代理"
$output += "    - https://1.1.1.1/dns-query#🚀 默认代理"
$output += "    - https://8.8.8.8/dns-query#🚀 默认代理"
$output += ""
$output += "  fallback-filter:"
$output += "    geoip: true"
$output += "    geoip-code: CN"
$output += "    ipcidr:"
$output += "      - 240.0.0.0/4"
$output += ""

# Sniffer
$output += "sniffer:"
$output += "  enable: true"
$output += "  sniff:"
$output += "    HTTP:"
$output += "      ports: [80, 8080-8880]"
$output += "      override-destination: true"
$output += "    TLS:"
$output += "      ports: [443, 8443]"
$output += "    QUIC:"
$output += "      ports: [443, 8443]"
$output += "  force-domain:"
$output += '    - "+.v2ex.com"'
$output += "  skip-domain:"
$output += '    - "rule-set:private_domain,cn_domain"'
$output += '    - "dlg.io.mi.com"'
$output += '    - "+.push.apple.com"'
$output += '    - "+.apple.com"'
$output += '    - "+.wechat.com"'
$output += '    - "+.qpic.cn"'
$output += '    - "+.qq.com"'
$output += '    - "+.wechatapp.com"'
$output += '    - "+.vivox.com"'
$output += '    - "+.oray.com"'
$output += '    - "+.sunlogin.net"'
$output += '    - "+.msftconnecttest.com"'
$output += '    - "+.msftncsi.com"'
$output += ""

# Proxies section
$output += "proxies:"
$output += "  - {name: '🟢 直连', type: direct, udp: true}"

# Helper to format proxy line
function Format-ProxyLine {
    param($proxy)
    $line = $proxy.rawLine -replace '^\s*-\s*', '  - '
    return $line.TrimEnd()
}

foreach ($p in $naiyunProxies) { $output += Format-ProxyLine $p }
foreach ($p in $taoluProxies) { $output += Format-ProxyLine $p }
foreach ($p in $mixueProxies) { $output += Format-ProxyLine $p }
$output += ""

# Helper: format name list as YAML string
function Format-Names {
    param([array]$proxies)
    $names = @()
    foreach ($p in $proxies) {
        $n = $p.name -replace "'", "''"
        $names += "'$n'"
    }
    return "[" + ($names -join ", ") + "]"
}

# Build all node names
$allNodeNames = @()
foreach ($p in $allProxies) { $allNodeNames += $p.name }

# Build default proxies list
$defaultList = @()
foreach ($key in @("hk","jp","us","sg","tw","eu","other")) {
    $defaultList += "🔯 $($regionNames[$key])故转"
    $defaultList += "♻️ $($regionNames[$key])自动"
}
$defaultList += "♻️ 自动选择"
foreach ($key in @("hk","jp","us","sg","tw","eu","other")) {
    $defaultList += "$($regionEmojis[$key]) $($regionNames[$key])节点"
}
$defaultList += "🌐 全部节点"
$defaultList += "🟢 直连"

$defaultListStr = ($defaultList | ForEach-Object { "'$_'" }) -join ", "

# pr anchor
$output += "pr: &pr {type: select, proxies: [$defaultListStr]}"
$output += ""

# Proxy groups
$output += "proxy-groups:"
$output += "  - {name: '🚀 默认代理', type: select, proxies: [$defaultListStr]}"
$output += ""

# App routing groups
$appGroups = @(
    @("📹 YouTube", "pr"), @("🍀 Google", "pr"), @("🤖 ChatGPT", "pr"),
    @("👨🏿‍💻 GitHub", "pr"), @("🐬 OneDrive", "pr"), @("🪟 Microsoft", "pr"),
    @("🎵 TikTok", "pr"), @("📲 Telegram", "pr"), @("🎥 NETFLIX", "pr"),
    @("✈️ Speedtest", "pr"), @("💶 PayPal", "pr")
)
foreach ($ag in $appGroups) {
    $output += "  - {name: '$($ag[0])', <<: *$($ag[1])}"
}
$output += "  - {name: '🍎 Apple', type: select, proxies: ['🟢 直连', '🚀 默认代理']}"
$output += "  - {name: '🎯 直连', type: select, proxies: ['🟢 直连', '🚀 默认代理']}"
$output += "  - {name: '🐟 漏网之鱼', <<: *pr}"
$output += ""

# Region select groups
foreach ($key in @("hk","jp","us","sg","tw","eu","other")) {
    $namesStr = Format-Names $regions[$key]
    $output += "  - {name: '$($regionEmojis[$key]) $($regionNames[$key])节点', type: select, proxies: $namesStr}"
}
$allNamesStr = Format-Names $allProxies
$output += "  - {name: '🌐 全部节点', type: select, proxies: $allNamesStr}"
$output += ""

# Fault tolerance (fallback) groups
foreach ($key in @("hk","jp","us","sg","tw","eu","other")) {
    $namesStr = Format-Names $regions[$key]
    $output += "  - {name: '🔯 $($regionNames[$key])故转', type: fallback, proxies: $namesStr, url: 'https://www.gstatic.com/generate_204', tolerance: 20, interval: 300}"
}
$output += ""

# Auto speed test groups
foreach ($key in @("hk","jp","us","sg","tw","eu","other")) {
    $namesStr = Format-Names $regions[$key]
    $output += "  - {name: '♻️ $($regionNames[$key])自动', type: url-test, proxies: $namesStr, url: 'https://www.gstatic.com/generate_204', tolerance: 20, interval: 300}"
}
$allNamesStr = Format-Names $allProxies
$output += "  - {name: '♻️ 自动选择', type: url-test, proxies: $allNamesStr, url: 'https://www.gstatic.com/generate_204', tolerance: 20, interval: 300}"
$output += ""

# Rules
$output += "rules:"
$rules = @(
    "DOMAIN-SUFFIX,ipapi.co,REJECT-DROP",
    "DOMAIN-SUFFIX,ipapi.is,REJECT-DROP",
    "DOMAIN-SUFFIX,ipwho.is,REJECT-DROP",
    "DOMAIN-SUFFIX,ip.sb,REJECT-DROP",
    "RULE-SET,private_domain,🟢 直连",
    "RULE-SET,apple_domain,🍎 Apple",
    "RULE-SET,ai,🤖 ChatGPT",
    "RULE-SET,github_domain,👨🏿‍💻 GitHub",
    "RULE-SET,youtube_domain,📹 YouTube",
    "RULE-SET,google_domain,🍀 Google",
    "RULE-SET,onedrive_domain,🐬 OneDrive",
    "RULE-SET,microsoft_domain,🪟 Microsoft",
    "RULE-SET,tiktok_domain,🎵 TikTok",
    "RULE-SET,speedtest_domain,✈️ Speedtest",
    "RULE-SET,telegram_domain,📲 Telegram",
    "RULE-SET,netflix_domain,🎥 NETFLIX",
    "RULE-SET,paypal_domain,💶 PayPal",
    "RULE-SET,gfw_domain,🚀 默认代理",
    "RULE-SET,geolocation-!cn,🚀 默认代理",
    "RULE-SET,cn_domain,🎯 直连",
    "RULE-SET,google_ip,🍀 Google,no-resolve",
    "RULE-SET,netflix_ip,🎥 NETFLIX,no-resolve",
    "RULE-SET,telegram_ip,📲 Telegram,no-resolve",
    "RULE-SET,cn_ip,🎯 直连",
    "MATCH,🐟 漏网之鱼"
)
foreach ($r in $rules) {
    $output += "  - $r"
}
$output += ""

# Rule-anchor
$output += "rule-anchor:"
$output += "  ip: &ip {type: http, interval: 86400, behavior: ipcidr, format: mrs}"
$output += "  domain: &domain {type: http, interval: 86400, behavior: domain, format: mrs}"
$output += "  class: &class {type: http, interval: 86400, behavior: classical, format: text}"
$output += ""

# Rule-providers
$output += "rule-providers:"
$providers = @(
    @("private_domain", "domain", "geosite", "private.mrs"),
    @("ai", "domain", "geosite", "category-ai-!cn.mrs"),
    @("youtube_domain", "domain", "geosite", "youtube.mrs"),
    @("google_domain", "domain", "geosite", "google.mrs"),
    @("github_domain", "domain", "geosite", "github.mrs"),
    @("telegram_domain", "domain", "geosite", "telegram.mrs"),
    @("netflix_domain", "domain", "geosite", "netflix.mrs"),
    @("paypal_domain", "domain", "geosite", "paypal.mrs"),
    @("onedrive_domain", "domain", "geosite", "onedrive.mrs"),
    @("microsoft_domain", "domain", "geosite", "microsoft.mrs"),
    @("apple_domain", "domain", "geosite", "apple-cn.mrs"),
    @("speedtest_domain", "domain", "geosite", "ookla-speedtest.mrs"),
    @("tiktok_domain", "domain", "geosite", "tiktok.mrs"),
    @("gfw_domain", "domain", "geosite", "gfw.mrs"),
    @("geolocation-!cn", "domain", "geosite", "geolocation-!cn.mrs"),
    @("cn_domain", "domain", "geosite", "cn.mrs"),
    @("cn_ip", "ip", "geoip", "cn.mrs"),
    @("google_ip", "ip", "geoip", "google.mrs"),
    @("telegram_ip", "ip", "geoip", "telegram.mrs"),
    @("netflix_ip", "ip", "geoip", "netflix.mrs")
)
foreach ($p in $providers) {
    $output += "  $($p[0]): { <<: *$($p[1]), url: ""https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/$($p[2])/$($p[3])""}"
}

# Write output
$outPath = "$base\merged_config.yaml"
$output -join "`r`n" | Out-File -FilePath $outPath -Encoding UTF8
Write-Host ""
Write-Host "✅ 已生成: $outPath"
Write-Host "   节点总数: $($allProxies.Count)"
