import {createHash} from 'node:crypto';
import path from 'node:path';
import {zipEntries} from './zip.mjs';
import {fail} from './validation.mjs';

export function spaceServerConfig(profile){
  const root=profile?.directory||'/www/wwwroot/pixixai.com';
  if(!/^\/[a-zA-Z0-9_./-]+$/.test(root)||root.split('/').some(part=>part==='.'||part==='..'))fail('生成配置时，网站目录请使用英文字母、数字及普通路径字符。');
  const key=createHash('sha256').update(root).digest('hex').slice(0,20),directory=path.posix.join(path.posix.dirname(root),'.portfolio-spaces',key),service=`[Unit]
Description=Portfolio private spaces
After=network.target

[Service]
Type=simple
User=www
Group=www
Environment=PORTFOLIO_PUBLIC_ROOT=${root}
Environment=PORTFOLIO_SPACE_PORT=4181
ExecStart=/usr/bin/node ${directory}/space-gateway.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0077

[Install]
WantedBy=multi-user.target
`;
  const nginx=`# Place inside this website's server { ... } block.
# Replace any existing location / block; preserve certificate challenge handling.
location = /__portfolio_space_health { return 404; }
location ^~ /.well-known/acme-challenge/ {
    try_files $uri =404;
}
location ^~ / {
    proxy_pass http://127.0.0.1:4181;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 120s;
}
`;
  const readme=`# 分享空间服务器配置（首次启用）

网站目录：${root}
私密文件：${directory}（位于网站目录外，请勿移动进网站目录）

1. 在后台发布，再使用“部署已发布网站”上传公开网站与私密数据。仅上传静态ZIP不能启用私密空间。
2. 在服务器安装Node.js 22或24 LTS。执行 \`command -v node\` 查看实际路径，将portfolio-spaces.service的ExecStart中 /usr/bin/node 改成该绝对路径。运行账户使用宝塔已有www账户。
3. 将portfolio-spaces.service放到 /etc/systemd/system/portfolio-spaces.service。若是首次非root账户上传，请让管理员将私密目录的组设置为www、目录750、文件640，并保证父目录可进入。
4. 执行以下命令启动服务：

    systemctl daemon-reload
    systemctl enable --now portfolio-spaces
    systemctl status portfolio-spaces --no-pager

5. 宝塔→网站→对应站点→设置→配置文件，先备份配置，再将nginx-location.conf放进server大括号内。已有location /时替换该段，不重复添加。此规则必须代理所有公开及私密请求；否则旧作品原文件可能仍从Nginx直接访问。配置包同时提供证书验证目录的专用规则；已有同名location时合并，不重复添加。
6. 保存前检查Nginx配置。通过后重载。完成域名HTTPS配置。4181只监听服务器本机，不要在防火墙放行。
7. 用手机或未解锁浏览器访问私密空间链接：应先显示访问码；输入正确访问码才能访问作品、图片和视频。公开空间无需访问码。再尝试另一个私密空间，不能沿用前一空间权限。检查未选入主站的作品在主站入口返回404。
8. 初次开通后，日常仍是本地编辑→发布→部署。新建或修改访问码使用4位数字，旧码在主动修改前仍可使用。修改访问码或关闭空间后同样需要发布并部署；每个空间自动包含所选标签下的作品，并过滤该空间的作品排除列表；排除在修改标签后仍保持，只有重新勾选作品才恢复。公开空间无需访问码，切换公开／私密也需要发布并部署。更新四位码支持或其他访问服务程序后，再执行systemctl restart portfolio-spaces。

提示：系统完整备份请使用“备份数据”，其中“作品”包括主站及分享空间的标签规则、排除记录和访问码校验数据。通用、腾讯、ESA静态ZIP包含主站及已启用的公开空间，不包含私密空间。
`;
  return zipEntries([{name:'portfolio-spaces.service',bytes:Buffer.from(service)},{name:'nginx-location.conf',bytes:Buffer.from(nginx)},{name:'首次启用说明.md',bytes:Buffer.from(readme.replaceAll('\`','`'))}]);
}
