#!/usr/bin/env python3
"""从 奶云.yaml 提取节点，使用 template.yaml 结构生成新配置文件"""

import re
import yaml

# 读取奶云原始配置
with open("奶云.yaml", "r", encoding="utf-8") as f:
    naiyun_config = yaml.safe_load(f)

# 提取所有代理节点
all_proxies = naiyun_config.get("proxies", [])

# 过滤掉信息节点（流量、到期、提示、官网等），只保留实际代理节点
info_keywords = ["流量", "到期", "看不到节点", "官网"]
actual_proxies = []
for p in all_proxies:
    name = p.get("name", "")
    is_info = any(kw in name for kw in info_keywords)
    if not is_info:
        actual_proxies.append(p)

# 按地区分类节点
def classify_proxy(name):
    """根据节点名称判断地区"""
    name_lower = name.lower()
    if "香港" in name or "hk" in name_lower:
        return "hk"
    elif "日本" in name or "jp" in name_lower:
        return "jp"
    elif "美国" in name or "us" in name_lower:
        return "us"
    elif "新加坡" in name or "sg" in name_lower:
        return "sg"
    elif "台湾" in name or "tw" in name_lower:
        return "tw"
    elif "德国" in name or "de" in name_lower:
        return "eu"
    elif "英国" in name or "uk" in name_lower:
        return "eu"
    elif "法国" in name or "fr" in name_lower:
        return "eu"
    elif "荷兰" in name or "nl" in name_lower:
        return "eu"
    elif "俄罗斯" in name or "ru" in name_lower:
        return "eu"
    elif "越南" in name or "vn" in name_lower:
        return "other"
    elif "加拿大" in name or "ca" in name_lower:
        return "other"
    elif "尼日利亚" in name or "ng" in name_lower:
        return "other"
    elif "印度" in name or "in" in name_lower:
        return "other"
    else:
        return "other"

regions = {"hk": [], "jp": [], "us": [], "sg": [], "tw": [], "eu": [], "other": []}
for p in actual_proxies:
    region = classify_proxy(p["name"])
    regions[region].append(p)

# 地区分组名称映射
region_names = {
    "hk": "香港",
    "jp": "日本",
    "us": "美国",
    "sg": "新加坡",
    "tw": "台湾",
    "eu": "欧洲",
    "other": "其他",
}
region_emojis = {
    "hk": "🇭🇰",
    "jp": "🇯🇵",
    "us": "🇺🇲",
    "sg": "🇸🇬",
    "tw": "🇹🇼",
    "eu": "🇪🇺",
    "other": "🌍",
}


def format_proxy(proxy):
    """将代理字典格式化为 YAML 行"""
    name = proxy["name"]
    # 构建 YAML 行
    parts = [f"  - {{name: '{name}'"]
    if "type" in proxy:
        parts.append(f"type: {proxy['type']}")
    if "server" in proxy:
        parts.append(f"server: {proxy['server']}")
    if "port" in proxy:
        parts.append(f"port: {proxy['port']}")
    if "password" in proxy:
        parts.append(f"password: {proxy['password']}")
    if "cipher" in proxy:
        parts.append(f"cipher: {proxy['cipher']}")
    if "udp" in proxy:
        parts.append(f"udp: {str(proxy['udp']).lower()}")
    if "sni" in proxy:
        parts.append(f"sni: {proxy['sni']}")
    if "skip-cert-verify" in proxy:
        parts.append(f"skip-cert-verify: {str(proxy['skip-cert-verify']).lower()}")
    if "client-fingerprint" in proxy:
        parts.append(f"client-fingerprint: {proxy['client-fingerprint']}")
    if "ip-version" in proxy:
        parts.append(f"ip-version: {proxy['ip-version']}")
    if "up" in proxy:
        parts.append(f"up: {proxy['up']}")
    if "down" in proxy:
        parts.append(f"down: {proxy['down']}")
    if "obfs" in proxy:
        parts.append(f"obfs: {proxy['obfs']}")
    if "obfs-password" in proxy:
        parts.append(f"obfs-password: {proxy['obfs-password']}")
    if "alpn" in proxy:
        parts.append(f"alpn: {proxy['alpn']}")
    return ", ".join(parts) + "}"


# 生成所有节点名称列表（用于 proxy-groups 引用）
all_node_names = [p["name"] for p in actual_proxies]

# 构建各地区节点名称列表
region_node_names = {}
for key, rname in region_names.items():
    region_node_names[key] = [p["name"] for p in regions[key]]

# 构建 proxy-groups 的引用列表字符串
def names_to_yaml_str(names):
    """将名称列表转为 YAML 数组字符串"""
    return "[" + ", ".join(f"'{n}'" for n in names) + "]"

# 构建默认代理组的代理列表（所有地区归转组 + 自动组 + 地区节点组 + 直连）
default_proxies_list = []
for key in ["hk", "jp", "us", "sg", "tw", "eu", "other"]:
    cn_name = region_names[key]
    emoji = region_emojis[key]
    default_proxies_list.append(f"🔯 {cn_name}故转")
    default_proxies_list.append(f"♻️ {cn_name}自动")
default_proxies_list.append("♻️ 自动选择")
for key in ["hk", "jp", "us", "sg", "tw", "eu", "other"]:
    cn_name = region_names[key]
    emoji = region_emojis[key]
    default_proxies_list.append(f"{emoji} {cn_name}节点")
default_proxies_list.append("🌐 全部节点")
default_proxies_list.append("🟢 直连")

# ===================== 生成输出文件 =====================
output = []
output.append("# ==========================================================")
output.append("# 奶云节点 + 模板分组规则")
output.append("# 生成说明：节点来自 奶云.yaml，分组/规则来自 template.yaml")
output.append("# ==========================================================")
output.append("mixed-port: 7890")
output.append("allow-lan: true")
output.append("bind-address: '*'")
output.append("mode: rule")
output.append("log-level: info")
output.append("external-controller: '127.0.0.1:9090'")
output.append("unified-delay: true")
output.append("tcp-concurrent: true")
output.append("global-client-fingerprint: chrome")
output.append("")

# DNS 部分（来自模板）
output.append("dns:")
output.append("  enable: true")
output.append("  ipv6: false")
output.append("  enhanced-mode: fake-ip")
output.append("  fake-ip-range: 198.18.0.1/16")
output.append("  listen: 0.0.0.0:7874")
output.append("  use-hosts: true")
output.append("  respect-rules: true")
output.append("")
output.append("  default-nameserver:")
output.append("    - 223.5.5.5")
output.append("    - 119.29.29.29")
output.append("    - 114.114.114.114")
output.append("")
output.append("  nameserver:")
output.append("    - https://dns.alidns.com/dns-query")
output.append("    - https://doh.pub/dns-query")
output.append("")
output.append("  proxy-server-nameserver:")
output.append("    - https://dns.alidns.com/dns-query")
output.append("    - https://doh.pub/dns-query")
output.append("")
output.append("  fallback:")
output.append("    - https://dns.google/dns-query#🚀 默认代理")
output.append("    - https://1.1.1.1/dns-query#🚀 默认代理")
output.append("    - https://8.8.8.8/dns-query#🚀 默认代理")
output.append("")
output.append("  fallback-filter:")
output.append("    geoip: true")
output.append("    geoip-code: CN")
output.append("    ipcidr:")
output.append("      - 240.0.0.0/4")
output.append("")

# Sniffer 部分（来自模板）
output.append("sniffer:")
output.append("  enable: true")
output.append("  sniff:")
output.append("    HTTP:")
output.append("      ports: [80, 8080-8880]")
output.append("      override-destination: true")
output.append("    TLS:")
output.append("      ports: [443, 8443]")
output.append("    QUIC:")
output.append("      ports: [443, 8443]")
output.append("  force-domain:")
output.append('    - "+.v2ex.com"')
output.append("  skip-domain:")
output.append('    - "rule-set:private_domain,cn_domain"')
output.append('    - "dlg.io.mi.com"')
output.append('    - "+.push.apple.com"')
output.append('    - "+.apple.com"')
output.append('    - "+.wechat.com"')
output.append('    - "+.qpic.cn"')
output.append('    - "+.qq.com"')
output.append('    - "+.wechatapp.com"')
output.append('    - "+.vivox.com"')
output.append('    - "+.oray.com"')
output.append('    - "+.sunlogin.net"')
output.append('    - "+.msftconnecttest.com"')
output.append('    - "+.msftncsi.com"')
output.append("")

# Proxies 部分
output.append("proxies:")
output.append("  - {name: '🟢 直连', type: direct, udp: true}")
for p in actual_proxies:
    output.append(format_proxy(p))
output.append("")

# pr 锚点
pr_proxies_str = ", ".join(f"'{n}'" for n in default_proxies_list)
output.append(f"pr: &pr {{type: select, proxies: [{pr_proxies_str}]}}")
output.append("")

# Proxy Groups
output.append("proxy-groups:")
# 默认代理
default_str = ", ".join(f"'{n}'" for n in default_proxies_list)
output.append(f"  - {{name: '🚀 默认代理', type: select, proxies: [{default_str}]}}")
output.append("")

# 基础应用分流
app_groups = [
    ("📹 YouTube", "pr"),
    ("🍀 Google", "pr"),
    ("🤖 ChatGPT", "pr"),
    ("👨🏿‍💻 GitHub", "pr"),
    ("🐬 OneDrive", "pr"),
    ("🪟 Microsoft", "pr"),
    ("🎵 TikTok", "pr"),
    ("📲 Telegram", "pr"),
    ("🎥 NETFLIX", "pr"),
    ("✈️ Speedtest", "pr"),
    ("💶 PayPal", "pr"),
]
for name, ref in app_groups:
    output.append(f"  - {{name: '{name}', <<: *{ref}}}")
output.append("  - {name: '🍎 Apple', type: select, proxies: ['🟢 直连', '🚀 默认代理']}")
output.append("  - {name: '🎯 直连', type: select, proxies: ['🟢 直连', '🚀 默认代理']}")
output.append("  - {name: '🐟 漏网之鱼', <<: *pr}")
output.append("")

# 地区节点手动选择
for key in ["hk", "jp", "us", "sg", "tw", "eu", "other"]:
    cn_name = region_names[key]
    emoji = region_emojis[key]
    names = region_node_names[key]
    names_str = ", ".join(f"'{n}'" for n in names)
    output.append(f"  - {{name: '{emoji} {cn_name}节点', type: select, proxies: [{names_str}]}}")
output.append("  - {name: '🌐 全部节点', type: select, proxies: [" + ", ".join(f"'{n}'" for n in all_node_names) + "]}")
output.append("")

# 地区故障转移
for key in ["hk", "jp", "us", "sg", "tw", "eu", "other"]:
    cn_name = region_names[key]
    names = region_node_names[key]
    names_str = ", ".join(f"'{n}'" for n in names)
    output.append(f"  - {{name: '🔯 {cn_name}故转', type: fallback, proxies: [{names_str}], url: 'https://www.gstatic.com/generate_204', tolerance: 20, interval: 300}}")
output.append("")

# 地区自动测速
for key in ["hk", "jp", "us", "sg", "tw", "eu", "other"]:
    cn_name = region_names[key]
    names = region_node_names[key]
    names_str = ", ".join(f"'{n}'" for n in names)
    output.append(f"  - {{name: '♻️ {cn_name}自动', type: url-test, proxies: [{names_str}], url: 'https://www.gstatic.com/generate_204', tolerance: 20, interval: 300}}")

# 全部自动选择
all_names_str = ", ".join(f"'{n}'" for n in all_node_names)
output.append(f"  - {{name: '♻️ 自动选择', type: url-test, proxies: [{all_names_str}], url: 'https://www.gstatic.com/generate_204', tolerance: 20, interval: 300}}")
output.append("")

# Rules 部分（来自模板）
output.append("rules:")
output.append("  - DOMAIN-SUFFIX,ipapi.co,REJECT-DROP")
output.append("  - DOMAIN-SUFFIX,ipapi.is,REJECT-DROP")
output.append("  - DOMAIN-SUFFIX,ipwho.is,REJECT-DROP")
output.append("  - DOMAIN-SUFFIX,ip.sb,REJECT-DROP")
output.append("  - RULE-SET,private_domain,🟢 直连")
output.append("  - RULE-SET,apple_domain,🍎 Apple")
output.append("  - RULE-SET,ai,🤖 ChatGPT")
output.append("  - RULE-SET,github_domain,👨🏿‍💻 GitHub")
output.append("  - RULE-SET,youtube_domain,📹 YouTube")
output.append("  - RULE-SET,google_domain,🍀 Google")
output.append("  - RULE-SET,onedrive_domain,🐬 OneDrive")
output.append("  - RULE-SET,microsoft_domain,🪟 Microsoft")
output.append("  - RULE-SET,tiktok_domain,🎵 TikTok")
output.append("  - RULE-SET,speedtest_domain,✈️ Speedtest")
output.append("  - RULE-SET,telegram_domain,📲 Telegram")
output.append("  - RULE-SET,netflix_domain,🎥 NETFLIX")
output.append("  - RULE-SET,paypal_domain,💶 PayPal")
output.append("  - RULE-SET,gfw_domain,🚀 默认代理")
output.append("  - RULE-SET,geolocation-!cn,🚀 默认代理")
output.append("  - RULE-SET,cn_domain,🎯 直连")
output.append("  - RULE-SET,google_ip,🍀 Google,no-resolve")
output.append("  - RULE-SET,netflix_ip,🎥 NETFLIX,no-resolve")
output.append("  - RULE-SET,telegram_ip,📲 Telegram,no-resolve")
output.append("  - RULE-SET,cn_ip,🎯 直连")
output.append("  - MATCH,🐟 漏网之鱼")
output.append("")

# Rule-anchor
output.append("rule-anchor:")
output.append("  ip: &ip {type: http, interval: 86400, behavior: ipcidr, format: mrs}")
output.append("  domain: &domain {type: http, interval: 86400, behavior: domain, format: mrs}")
output.append("  class: &class {type: http, interval: 86400, behavior: classical, format: text}")
output.append("")

# Rule-providers
output.append("rule-providers:")
providers = [
    ("private_domain", "private.mrs"),
    ("ai", "category-ai-!cn.mrs"),
    ("youtube_domain", "youtube.mrs"),
    ("google_domain", "google.mrs"),
    ("github_domain", "github.mrs"),
    ("telegram_domain", "telegram.mrs"),
    ("netflix_domain", "netflix.mrs"),
    ("paypal_domain", "paypal.mrs"),
    ("onedrive_domain", "onedrive.mrs"),
    ("microsoft_domain", "microsoft.mrs"),
    ("apple_domain", "apple-cn.mrs"),
    ("speedtest_domain", "ookla-speedtest.mrs"),
    ("tiktok_domain", "tiktok.mrs"),
    ("gfw_domain", "gfw.mrs"),
    ("geolocation-!cn", "geolocation-!cn.mrs"),
    ("cn_domain", "cn.mrs"),
    ("cn_ip", "cn.mrs"),
    ("google_ip", "google.mrs"),
    ("telegram_ip", "telegram.mrs"),
    ("netflix_ip", "netflix.mrs"),
]

for name, file in providers:
    if "_ip" in name or name in ["cn_ip", "google_ip", "telegram_ip", "netflix_ip"]:
        output.append(f"  {name}: {{ <<: *ip, url: \"https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geoip/{file}\"}}")
    else:
        output.append(f"  {name}: {{ <<: *domain, url: \"https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/{file}\"}}")

# 写入文件
output_path = "奶云_template.yaml"
with open(output_path, "w", encoding="utf-8") as f:
    f.write("\n".join(output))

print(f"✅ 已生成 {output_path}")
print(f"   节点总数: {len(actual_proxies)}")
for key in ["hk", "jp", "us", "sg", "tw", "eu", "other"]:
    print(f"   {region_emojis[key]} {region_names[key]}: {len(regions[key])} 个节点")
