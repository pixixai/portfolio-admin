import {readdir,stat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fail} from './validation.mjs';
import {zipEntries} from './zip.mjs';
const MB=1024*1024;
export const deploymentPlatforms=[
  {id:'generic',label:'通用静态网站',description:'index.html位于最外层，适合一般静态托管；不套用腾讯／阿里云配额。',fileLimit:65535,fileSizeLimit:null},
  {id:'edgeone',label:'腾讯 EdgeOne Pages / Makers',description:'上传ZIP即可部署，index.html位于最外层，并附带更新缓存配置和说明。',fileLimit:20000,fileSizeLimit:25*MB},
  {id:'esa',label:'阿里云 ESA Pages',description:'解压后通过Git或CLI部署；包含public目录、esa.jsonc和说明，不是控制台直接拖放ZIP。',fileLimit:2000,fileSizeLimit:25*MB,packageLimit:1024*MB},
];
export function deploymentTarget(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('部署平台设置格式不正确。');
  const platform=input.platform??'generic';if(!deploymentPlatforms.some(item=>item.id===platform))fail('请选择有效的部署平台。');
  const projectName=input.projectName??'portfolio-site';
  if(platform==='esa'&&(typeof projectName!=='string'||projectName.length<2||projectName.length>41||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(projectName)))fail('ESA项目名称须为2～41位小写字母、数字或连字符，以字母开头，不能以连字符结尾。');
  return{platform,projectName:platform==='esa'?projectName:'portfolio-site'};
}
function extras(target){
  if(target.platform==='generic')return[];
  const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
  if(target.platform==='edgeone')return[
    {name:'edgeone.json',bytes:json({headers:['/','/index.html','/data/*'].map(source=>({source,headers:[{key:'Cache-Control',value:'public, max-age=0, must-revalidate'}]}))})},
    {name:'DEPLOY.md',bytes:Buffer.from('# 腾讯 EdgeOne Pages / Makers 部署\n\n在控制台创建项目，选择“直接上传”，上传整个ZIP即可；不要再包一层dist目录，也不用运行构建。以后在同一个项目中新建部署并上传新包。\n\nedgeone.json为首页与作品数据配置重新验证缓存，避免更新后继续读取旧内容。\n\n此包只包含作品展示站，可从后台重新导入；不包含管理服务或云账号。\n\n官方说明：https://pages.edgeone.ai/document/direct-upload\n')},
  ];
  return[
    {name:'esa.jsonc',bytes:json({name:target.projectName,installCommand:'',buildCommand:'',assets:{directory:'./public',notFoundStrategy:'singlePageApplication'}})},
    {name:'DEPLOY.md',bytes:Buffer.from(`# 阿里云 ESA Pages 部署\n\n先解压此ZIP。这是已构建的静态项目包，不是控制台直接拖放ZIP。\n\n## Git仓库方式（推荐）\n\n将解压得到的esa.jsonc与public目录一起放入作品站专用仓库，再从ESA控制台导入该仓库。根目录选择仓库根目录，静态资源目录为public，不安装依赖、不运行构建，不设置函数入口。不要把整个管理后台仓库当成这个作品站包上传。\n\n## CLI方式\n\n按官方文档安装与登录ESA CLI后，在esa.jsonc所在目录执行：\n\n\`\`\`text\nesa-cli login\nesa-cli deploy\n\`\`\`\n\n项目名为${target.projectName}；同名项目存在时会更新该项目，请在部署前核对esa.jsonc中的name。CLI平台与运行环境要求请以官方文档为准，Windows用户可优先使用Git仓库方式。\n\npublic/index.html是展示站入口。恢复到后台时直接选择完整ZIP，无需移出public中的文件。此包不包含云凭据、管理后台或未发布草稿。\n\n官方配置：https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/build-pages\n官方CLI：https://github.com/aliyun/alibabacloud-esa-cli\n`)},
  ];
}
export function deploymentReport(files,input={}){
  const target=deploymentTarget(input),profile=deploymentPlatforms.find(item=>item.id===target.platform),extra=extras(target),prefix=target.platform==='esa'?'public/':'',errors=[];
  if(!files.some(file=>file.name==='index.html'))errors.push('部署目录缺少最外层index.html。');
  const names=new Set();for(const file of files){const lower=file.name.toLowerCase();if(names.has(lower))errors.push(`文件名重复：${file.name}`);names.add(lower);if(file.name.startsWith('/')||file.name.split('/').some(part=>!part||part==='.'||part==='..')||/[\\\x00-\x1f]/.test(file.name)||target.platform!=='generic'&&/[:*?"<>|]/.test(file.name))errors.push(`文件名不符合平台要求：${file.name}`);if(profile.fileSizeLimit&&file.size>profile.fileSizeLimit)errors.push(`“${file.displayName||file.name}”超过25 MB，请压缩或替换后重试。`);}
  if(extra.some(file=>names.has(file.name.toLowerCase()))&&target.platform==='edgeone')errors.push('部署目录已存在edgeone.json或DEPLOY.md，不能覆盖自定义配置。');
  const fileCount=files.length+(target.platform==='edgeone'?extra.length:0);
  if(fileCount>profile.fileLimit)errors.push(`文件数量${fileCount}超过${profile.label}的${profile.fileLimit}个限制。`);
  const packageSize=22+files.reduce((sum,file)=>sum+file.size+76+2*Buffer.byteLength(prefix+file.name),0)+extra.reduce((sum,file)=>sum+file.bytes.length+76+2*Buffer.byteLength(file.name),0);
  if(profile.packageLimit&&packageSize>profile.packageLimit)errors.push('ESA部署包超过1024 MB限制。');
  return{...target,label:profile.label,fileCount,totalBytes:files.reduce((sum,file)=>sum+file.size,0),packageSize,errors};
}
export async function inspectDeployment(directory,input={},store=null){
  const files=[],assetNames=new Map(store?.media().map(asset=>[asset.file,asset.name])||[]);
  async function walk(folder){for(const entry of await readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isSymbolicLink())fail('部署目录不能包含符号链接。');if(entry.isDirectory())await walk(file);else if(entry.isFile())files.push({name:path.relative(directory,file).split(path.sep).join('/'),file,size:(await stat(file)).size,displayName:assetNames.get(entry.name)||entry.name});}}
  await walk(directory);const report=deploymentReport(files,input);return{files,report};
}
export async function checkDeployment(directory,input,store=null){const {report}=await inspectDeployment(directory,input,store);if(report.errors.length)fail(report.errors.slice(0,8).join('\n'));return report;}
export async function deploymentPackage(directory,input={},store=null){
  const {files,report}=await inspectDeployment(directory,input,store);if(report.errors.length)fail(report.errors.slice(0,8).join('\n'));
  const prefix=report.platform==='esa'?'public/':'',entries=[];
  for(const file of files)entries.push({name:prefix+file.name,bytes:await readFile(file.file)});entries.push(...extras(report));
  return {bytes:zipEntries(entries),report};
}
