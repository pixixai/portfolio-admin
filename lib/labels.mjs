// `labels` is canonical; category/tags remain compatible with older exports.
export function projectLabels(document) {
  return [...new Set((Array.isArray(document?.labels) ? document.labels : [document?.category, ...(Array.isArray(document?.tags) ? document.tags : [])]).filter(value => typeof value === 'string' && value.trim() && value !== '未分类'))];
}

export function orderedLabelNames(settings,documents=[],spaces=[]){
  return [...new Set([...(settings?.categories||[]),...spaces.filter(Boolean).flatMap(space=>Array.isArray(space.groups)?space.groups.map(group=>group.label):space.labels||[]),...documents.filter(Boolean).flatMap(projectLabels)].filter(label=>typeof label==='string'&&label.trim()))];
}
export function orderLabelGroups(space,order){
  if(!space||!Array.isArray(space.groups))return space;
  const ranks=new Map(order.map((label,index)=>[label,index])),groups=[...space.groups].sort((a,b)=>(ranks.get(a.label)??Infinity)-(ranks.get(b.label)??Infinity));
  if(groups.every((group,index)=>group===space.groups[index]))return space;
  return {...space,groups,...(Array.isArray(space.labels)?{labels:groups.filter(group=>group.mode==='all').map(group=>group.label)}:{})};
}
export function withoutLocalProjectOrder(space){
  if(!space?.groups?.some(group=>Object.hasOwn(group,'orderIds')))return space;
  return {...space,groups:space.groups.map(({orderIds,...group})=>group)};
}
