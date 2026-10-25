// `labels` is canonical; category/tags remain compatible with older exports.
export function projectLabels(document) {
  return [...new Set((Array.isArray(document?.labels) ? document.labels : [document?.category, ...(Array.isArray(document?.tags) ? document.tags : [])]).filter(value => typeof value === 'string' && value.trim() && value !== '未分类'))];
}
