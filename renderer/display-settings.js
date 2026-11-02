// Shared by the renderer, server validation and settings defaults.
export const gradientPresets = [
  {name:'暮色蓝紫',startColor:'#173d7a',endColor:'#4c1d5b',angle:135,startOpacity:100,endOpacity:100},
  {name:'青绿深海',startColor:'#214d3d',endColor:'#10284a',angle:135,startOpacity:100,endOpacity:100},
  {name:'暖橙玫红',startColor:'#ed924b',endColor:'#b52b74',angle:135,startOpacity:100,endOpacity:100},
  {name:'黑色渐隐',startColor:'#000000',endColor:'#000000',angle:180,startOpacity:0,endOpacity:100},
  {name:'蓝色渐隐',startColor:'#173d7a',endColor:'#10284a',angle:180,startOpacity:0,endOpacity:100},
];
export const defaultGradient = (fade=false) => ({enabled:fade,angle:180,startColor:'#000000',endColor:fade?'#000000':'#173d7a',startOpacity:fade?0:100,endOpacity:100});
export const defaultGallery = () => ({maxWidth:1620,paddingDesktop:44,paddingMobile:20,gapDesktop:5,gapMobile:3,columnsDesktop:4,columnsMobile:2,radius:0,infoMode:'hover',shadeColor:'#000000',shadeOpacity:50,shadeGradient:defaultGradient(true)});
export const defaultFooter = () => ({endnote:'每一个项目，都是一次新的探索。',icpNumber:'陕ICP备00000000号-1（示例）',policeNumber:'陕公网安备00000000000000号（示例）'});
const color=value=>typeof value==='string'&&/^#[a-f\d]{6}$/i.test(value);
const number=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const invalid=message=>{throw Object.assign(new Error(message),{status:400});};
export function normalizeGradient(value,fade=false,strict=false) {
  const defaults=defaultGradient(fade),result={};
  if(value!=null&&(typeof value!=='object'||Array.isArray(value))){if(strict)invalid('渐变设置格式不正确。');value=null;}
  for(const [key,fallback] of Object.entries(defaults)){
    const item=value?.[key]??fallback;
    const valid=key==='enabled'?typeof item==='boolean':key.endsWith('Color')?color(item):number(item,0,key==='angle'?360:100);
    if(!valid&&strict)invalid('渐变颜色或方向、不透明度不正确。');
    result[key]=valid?(typeof item==='string'?item.toLowerCase():item):fallback;
  }
  return result;
}
export function normalizeGallery(value,strict=false) {
  const defaults=defaultGallery(),result={};
  if(value!=null&&(typeof value!=='object'||Array.isArray(value))){if(strict)invalid('瀑布流设置格式不正确。');value=null;}
  const ranges={maxWidth:[640,2560],paddingDesktop:[0,160],paddingMobile:[0,80],gapDesktop:[0,80],gapMobile:[0,48],columnsDesktop:[1,8],columnsMobile:[1,2],radius:[0,80],shadeOpacity:[0,100]};
  for(const [key,fallback] of Object.entries(defaults)){
    if(key==='shadeGradient'){result[key]=normalizeGradient(value?.[key],true,strict);continue;}
    const item=value?.[key]??fallback,valid=key==='infoMode'?['hover','always'].includes(item):key==='shadeColor'?color(item):number(item,...ranges[key])&&Number.isInteger(item);
    if(!valid&&strict)invalid('瀑布流参数不正确，请检查数值范围。');
    result[key]=valid?item:fallback;
  }
  return result;
}
export function shadeCSS(value,fade=false) {
  const solid=color(value?.shadeColor)?value.shadeColor:'#000000',gradient=normalizeGradient(value?.shadeGradient,fade);
  if(!gradient.enabled)return solid;
  const rgba=(hex,opacity)=>`rgba(${[1,3,5].map(index=>parseInt(hex.slice(index,index+2),16)).join(',')},${opacity/100})`;
  return `linear-gradient(${gradient.angle}deg,${rgba(gradient.startColor,gradient.startOpacity)} 0%,${rgba(gradient.endColor,gradient.endOpacity)} 100%)`;
}
export function galleryLayout(settings,width,viewportWidth) {
  const value=normalizeGallery(settings),mobile=viewportWidth<=760,gap=mobile?value.gapMobile:value.gapDesktop;
  const automatic=width>=1200?Math.max(4,Math.floor((width+gap)/(280+gap))):width>=820?3:width>=300?2:1;
  return {columns:mobile?Math.min(value.columnsMobile,width<300?1:2):Math.min(value.columnsDesktop,automatic),gap};
}
export function galleryCSS(settings) {
  const value=normalizeGallery(settings);
  return `:root{--works-max-width:${value.maxWidth}px;--works-padding:${value.paddingDesktop}px;--works-mobile-padding:${value.paddingMobile}px;--works-gap:${value.gapDesktop}px;--works-mobile-gap:${value.gapMobile}px;--works-columns:${value.columnsDesktop};--works-mobile-columns:${value.columnsMobile};--works-radius:${value.radius}px;--card-shade-background:${shadeCSS(value,true)};--card-shade-opacity:${value.shadeOpacity/100}}`;
}
