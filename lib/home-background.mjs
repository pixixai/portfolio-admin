const invalid = message => { throw Object.assign(new Error(message), {status:400}); };
export const defaultHomeBackground = () => ({videos:[{assetId:null,playbackRate:1}],finalFrameAssetId:null,shadeOpacity:80,loop:true});
export function homeBackgroundAssets(settings) {
  const value=settings?.homeBackground;
  return [...new Set([...(value?.videos||[]).map(item=>item.assetId),value?.finalFrameAssetId].filter(Boolean))];
}
export function validateHomeBackground(input,store) {
  if (input == null) return defaultHomeBackground();
  if (!input || !Array.isArray(input.videos) || input.videos.length>30) invalid('首页背景最多支持30项媒体。');
  const shadeOpacity=input.shadeOpacity??80;
  const loop=input.loop??true;if(typeof loop!=='boolean')invalid('循环播放开关格式不正确。');
  if (!Number.isInteger(shadeOpacity)||shadeOpacity<0||shadeOpacity>100) invalid('黑色蒙板不透明度须为0～100的整数。');
  const videos=input.videos.map(item=>{
    if (!item || typeof item!=='object' || item.assetId!=null&&typeof item.assetId!=='string' || item.type!=null&&!['image','video'].includes(item.type)) invalid('首页媒体格式不正确。');
    const asset = item.assetId && store?.asset(item.assetId);
    if (item.assetId && store && !/^(image|video)\//.test(asset?.mime || '')) invalid('首页媒体不存在或类型不匹配。');
    if (item.type && asset && !asset.mime.startsWith(item.type + '/')) invalid('首页媒体类型不匹配。');
    if (item.type==='image' || asset?.mime.startsWith('image/')) {
      const duration = item.duration ?? 5;
      if (!item.assetId || !Number.isFinite(duration) || duration<1 || duration>120) invalid('图片停留时长须为1～120秒。');
      return {assetId:item.assetId,type:'image',duration};
    }
    const playbackRate=Number(item.playbackRate);
    if (!Number.isFinite(playbackRate)||playbackRate<.25||playbackRate>4) invalid('视频速度须在0.25～4倍之间。');
    return {assetId:item.assetId||null,playbackRate};
  });
  const finalFrameAssetId=input.finalFrameAssetId||null;
  if (finalFrameAssetId && (typeof finalFrameAssetId!=='string' || store && !store.asset(finalFrameAssetId)?.mime.startsWith('image/'))) invalid('结束定格帧需要使用有效图片。');
  return {videos,finalFrameAssetId,shadeOpacity,loop};
}
