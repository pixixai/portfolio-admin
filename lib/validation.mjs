import { randomUUID } from 'node:crypto';
import { projectLabels } from './labels.mjs';
import { coverAssetId, usesFirstImage } from './cover.mjs';
import { validateHomeBackground } from './home-background.mjs';
import {enforcePrivacy} from './spaces.mjs';
export function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
const text = (value, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('请填写有效文本，且不要超过允许长度。');
  return value.trim();
};
export function validateProject(input, current, store) {
  if (!input || typeof input !== 'object') fail('作品格式不正确。');
  const id = current?.id || `work-${randomUUID().slice(0, 8)}`;
  const title = text(input.title, 120, true);
  if (input.labels != null && (!Array.isArray(input.labels) || input.labels.length > 30)) fail('最多选择30个标签。');
  const labels = Array.isArray(input.labels) ? [...new Set(input.labels.map(label => text(label, 40, true)))].filter(label => label !== '未分类') : projectLabels(input);
  if (labels.length > 30) fail('最多选择30个标签。');
  const blocks = input.blocks;
  if (input.useFirstImage != null && typeof input.useFirstImage !== 'boolean') fail('首图封面开关格式不正确。');
  if (!Array.isArray(blocks) || blocks.length > 300) fail('作品最多支持300个内容块。');
  const document = {
    id, folder: current?.folder || `${title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 65) || '作品'}-${id}`,
    title, category: labels[0] || '未分类', labels, description: text(input.description || '', 2000),
    english: current?.english || title, tags: labels.map(label => text(label, 40, true)),
    order: Number.isFinite(Number(input.order)) ? Math.max(-100000, Math.min(100000, Number(input.order))) : 999,
    coverAssetId: input.coverAssetId || null, coverRatio: input.coverRatio || 'auto',
    ...(input.visibility!=null?{visibility:input.visibility}:{}),
    ...(input.useFirstImage != null ? { useFirstImage: input.useFirstImage } : {}),
    coverCrop: input.coverCrop == null ? null : { x: Number(input.coverCrop.x), y: Number(input.coverCrop.y), zoom: Number(input.coverCrop.zoom) },
    blocks: blocks.map(block => {
      if (!block || typeof block !== 'object') fail('内容块格式不正确。');
      const id = /^[\w-]{1,80}$/.test(block.id || '') ? block.id : randomUUID();
      if (block.indent != null && (!Number.isInteger(block.indent) || block.indent < 0 || block.indent > 6)) fail('块缩进级别不正确。');
      const indentation = block.indent ? { indent: block.indent } : {};
      if (['image', 'video', 'audio'].includes(block.type)) {
        const asset = store.asset(block.assetId);
        if (!asset || !asset.mime.startsWith(block.type + '/')) fail('媒体不存在或类型不匹配，请重新选择。');
        return { id, type: block.type, assetId: block.assetId, alt: text(block.alt || '', 300), ...indentation };
      }
      if (!['text', 'heading', 'table'].includes(block.type)) fail('不支持的内容块。');
      const value = block.text ?? ''; text(value, block.type === 'heading' ? 200 : 30000);
      return { id, type: block.type, text: value, ...(block.indent ? { indent: block.indent } : {}) };
    }),
  };
  if (document.coverAssetId && !store.asset(document.coverAssetId)?.mime.startsWith('image/')) fail('封面需要使用图片。');
  if (document.coverCrop && ((!coverAssetId(document) && !usesFirstImage(document)) || !Number.isFinite(document.coverCrop.x) || !Number.isFinite(document.coverCrop.y) || !Number.isFinite(document.coverCrop.zoom) || document.coverCrop.x < 0 || document.coverCrop.x > 1 || document.coverCrop.y < 0 || document.coverCrop.y > 1 || document.coverCrop.zoom < 1 || document.coverCrop.zoom > 4)) fail('封面裁切参数不正确。');
  if (new Set(document.blocks.map(block => block.id)).size !== document.blocks.length) fail('内容块标识不能重复。');
  if (!['auto', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'].includes(document.coverRatio)) fail('封面比例不正确。');
  return enforcePrivacy(document,current,store);
}
export function validateSettings(input,store) {
  if (!input || typeof input !== 'object' || !['titleLines', 'categories', 'skills'].every(key => Array.isArray(input[key])) || !Array.isArray(input.contact?.emails) || input.skills.some(pair => !Array.isArray(pair))) fail('网站设置格式不正确。');
  const result = {
    title: text(input.title, 120, true), owner: text(input.owner, 50, true), year: text(input.year, 10, true),
    description: text(input.description || '', 500), brand: text(input.brand, 50, true), role: text(input.role, 50, true),
    tagline: text(input.tagline, 200, true), titleLines: (input.titleLines || []).map(line => text(line, 30, true)),
    categories: [...new Set((input.categories || []).map(category => text(category, 40, true)))],
    skills: (input.skills || []).map(pair => [text(pair[0], 10, true), text(pair[1], 50)]),
    contact: { bilibiliName: text(input.contact?.bilibiliName, 80, true), wechat: text(input.contact?.wechat, 80, true), emails: (input.contact?.emails || []).map(email => text(email, 120, true)) },
    appearance: { accent: input.appearance?.accent, coverRadius: Number(input.appearance?.coverRadius) },
    homeBackground: validateHomeBackground(input.homeBackground,store),
    footer: { text: text(input.footer?.text ?? `© ${input.year} ${input.owner} · 作品集`, 1000), registrationText: text(input.footer?.registrationText || '', 120), registrationUrl: text(input.footer?.registrationUrl || '', 500) },
  };
  if (result.titleLines.length !== 2 || result.skills.length !== 6 || result.contact.emails.length !== 2 || result.categories.filter(label=>label!=='未分类').length > 200) fail('请保留两行标题、六个技能词和两个邮箱，标签最多200项。');
  if (result.contact.emails.some(email => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))) fail('邮箱格式不正确。');
  if (result.footer.registrationUrl) {
    let url; try { url=new URL(result.footer.registrationUrl); } catch { fail('备案链接需要使用有效的HTTPS网址。'); }
    if (url.protocol!=='https:') fail('备案链接需要使用HTTPS网址。');
  }
  if (!/^#[a-f\d]{6}$/i.test(result.appearance.accent) || !Number.isFinite(result.appearance.coverRadius) || result.appearance.coverRadius < 0 || result.appearance.coverRadius > 40) fail('外观参数不正确。');
  return result;
}
