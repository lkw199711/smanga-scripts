echo '# Proxy for OpenClash
export http_proxy="http://Clash:ykt3thsw@192.168.100.1:7893"
export https_proxy="http://Clash:ykt3thsw@192.168.100.1:7893"
export HTTP_PROXY="http://Clash:ykt3thsw@192.168.100.1:7893"
export HTTPS_PROXY="http://Clash:ykt3thsw@192.168.100.1:7893"
export no_proxy="localhost,127.0.0.1,::1,192.168.0.0/16"' >> ~/.bashrc

echo '# Proxy for OpenClash
export http_proxy="http://Clash:ykt3thsw@192.168.100.1:7893"
export https_proxy="http://Clash:ykt3thsw@192.168.100.1:7893"
export HTTP_PROXY="http://Clash:ykt3thsw@192.168.100.1:7893"
export HTTPS_PROXY="http://Clash:ykt3thsw@192.168.100.1:7893"
export no_proxy="localhost,127.0.0.1,::1,192.168.0.0/16"' >> /etc/environment

source /etc/environment
source ~/.bashrc

curl -I --connect-timeout 5 https://www.google.com

auto ens192
iface ens192 inet static
address 192.168.5.13
netmask 255.255.255.0
gateway 192.168.5.4
dns-nameservers 192.168.5.4 223.5.5.5

auto ens224
iface ens224 inet static
address 192.168.100.13
netmask 255.255.255.0
#gateway 192.168.100.1
#dns-nameservers 192.168.5.4 223.5.5.5