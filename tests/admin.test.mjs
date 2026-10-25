import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplication, root } from '../server.mjs';
import { Window } from 'happy-dom';
import { openStore } from '../lib/store.mjs';
import { deflateSync } from 'node:zlib';

function testPng() {
  const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const bytes = Buffer.concat([Buffer.from(type), data]), header = Buffer.alloc(4), tail = Buffer.alloc(4); header.writeUInt32BE(data.length); tail.writeUInt32BE(crc(bytes)); return Buffer.concat([header, bytes, tail]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(6); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc(4 * (6 * 3 + 1), 180); for (let row = 0; row < 4; row++) rows[row * 19] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function testWav() {
  const bytes = Buffer.alloc(16044); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(16000, 40); return bytes;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  throw new Error(`等待超时：${message}`);
}
function zipEntries(bytes) {
  const files = new Map(); let position = 0;
  while (bytes.readUInt32LE(position) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(position + 8), 0);
    const size = bytes.readUInt32LE(position + 18), nameLength = bytes.readUInt16LE(position + 26), extra = bytes.readUInt16LE(position + 28);
    const name = bytes.toString('utf8', position + 30, position + 30 + nameLength);
    const start = position + 30 + nameLength + extra;
    assert.ok(!name.startsWith('/') && !name.split('/').includes('..'));
    files.set(name, bytes.subarray(start, start + size)); position = start + size;
  }
  assert.equal(bytes.readUInt32LE(position), 0x02014b50);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length - 12), files.size);
  return files;
}

test('独立管理系统完整工作流', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pixix-admin-test-'));
  const app = await createApplication({ dataDir });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  let cookie = '', initial, saved, duplicate, uploaded, publishedRelease, mediaProject;
  async function request(url, method = 'GET', data, { anonymous = false, headers = {} } = {}) {
    const response = await fetch(base + url, { method, headers: { ...(anonymous ? {} : { Cookie: cookie }), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    const setCookie = response.headers.get('set-cookie'); if (setCookie && !anonymous) cookie = setCookie.split(';')[0];
    const value = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { response, value };
  }
  async function ok(url, method, data, expected = 200) { const result = await request(url, method, data); assert.equal(result.response.status, expected, JSON.stringify(result.value)); return result.value; }
  async function job(job) { await until(() => app.publisher.jobs.get(job.id).status !== 'running', '生成站点'); const result = app.publisher.jobs.get(job.id); assert.equal(result.status, 'done', result.message); await until(() => !app.publisher.busy, '发布队列结束'); return result; }
  const manifest = async (prefix = '/site/') => ok(prefix + 'data/projects.json');

  await t.test('首次初始化直接进入，保留本机来源限制且数据目录不可直接访问', async () => {
    initial = await ok('/api/state');
    assert.equal(initial.projects.length, 2); assert.equal(initial.media.length, 4); assert.equal(initial.releases.length, 1);
    assert.equal(initial.projects.reduce((total, row) => total + row.draft.blocks.filter(block => block.type === 'image').length, 0), 2);
    assert.equal(initial.account, undefined);assert.equal(cookie,'');
    assert.equal((await request('/api/state', 'GET', undefined, { anonymous: true })).response.status, 200);
    assert.equal((await request('/api/state', 'GET', undefined, { headers:{Origin:'http://evil.invalid'} })).response.status,403);
    assert.equal((await request('/api/projects', 'POST', {}, { headers:{Origin:'http://evil.invalid'} })).response.status,403);
    assert.equal((await request('/data/portfolio.sqlite')).response.status, 404);
    assert.equal((await request('/renderer/site.json')).response.status, 404);
    for(const [route,method] of [['session','GET'],['setup','POST'],['login','POST'],['logout','POST'],['account','PUT']])assert.equal((await request('/api/'+route,method)).response.status,404);
  });

  await t.test('保存草稿、冲突保护、输入校验和公开展示互相隔离', async () => {
    const row = initial.projects[0], before = await manifest();
    saved = await ok(`/api/projects/${row.id}`, 'PUT', { ...row.draft, title: '测试草稿 <设计> $&', revision: row.revision });
    assert.equal(saved.revision, row.revision + 1); assert.equal(saved.live.title, row.live.title);
    assert.deepEqual(await manifest(), before);
    assert.equal((await request(`/api/projects/${row.id}`, 'PUT', { ...row.draft, revision: row.revision })).response.status, 409);
    assert.equal((await request('/api/projects', 'POST', { ...row.draft, blocks: [null] })).response.status, 400);
    assert.equal((await request('/api/settings', 'PUT', { ...initial.settings, revision: 1, skills: 'bad' })).response.status, 400);
    assert.equal((await request('/api/preview', 'POST', null)).response.status, 400);
    assert.equal((await request(`/api/media/${initial.media[0].id}`, 'DELETE')).response.status, 409);
  });

  await t.test('真实文件上传、去重、独立封面和私有预览', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6XFAAAAAASUVORK5CYII=', 'base64');
    async function upload(bytes, name) { const response = await fetch(base + '/api/media?name=' + encodeURIComponent(name), { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'image/png' }, body: bytes }); return { status: response.status, value: await response.json() }; }
    assert.equal((await upload(Buffer.from('<svg><script>bad</script></svg>'), 'bad.svg')).status, 400);
    const result = await upload(png, '测试图片.png'); assert.equal(result.status, 201); uploaded = result.value;
    assert.equal(uploaded.width, 1); assert.equal((await upload(png, '重复图片.png')).value.id, uploaded.id);
    duplicate = await ok(`/api/projects/${saved.id}/duplicate`, 'POST', {}, 201);
    assert.equal(duplicate.live, null); assert.notEqual(duplicate.id, saved.id);
    duplicate = await ok(`/api/projects/${duplicate.id}`, 'PUT', { ...duplicate.draft, title: '新作品 · 预览专用', coverAssetId: uploaded.id, coverRatio: '16:9', revision: duplicate.revision, blocks: [{ id: 'text-one', type: 'heading', text: '设计过程' }, { id: 'image-one', type: 'image', assetId: uploaded.id, alt: '新上传图片' }, { id: 'text-two', type: 'text', text: '这个段落支持 **加粗**。' }] });
    const preview = await job(await ok('/api/preview', 'POST', {}, 202));
    assert.equal((await request(preview.url, 'GET', undefined, { anonymous: true })).response.status, 200);
    assert.equal((await request(preview.url, 'GET', undefined, { headers:{'Sec-Fetch-Site':'cross-site'} })).response.status,403);
    const html = (await request(preview.url)).value;
    assert.ok(html.includes('新作品 · 预览专用')); assert.ok(html.includes('data-ratio="16:9"')); assert.ok(html.includes('测试草稿 &lt;设计&gt; $&'));
    const previewManifest = await manifest(preview.url);
    assert.ok(JSON.stringify(previewManifest).includes('新作品 · 预览专用'));
    assert.ok(!JSON.stringify(await manifest()).includes('新作品 · 预览专用'));
  });

  await t.test('选定发布仅更新所选作品；发布失败保留上一版', async () => {
    await job(await ok('/api/publish', 'POST', { projectIds: [duplicate.id], includeSettings: false }, 202));
    let state = await ok('/api/state'); publishedRelease = state.currentRelease;
    assert.equal(state.projects.find(row => row.id === saved.id).live.title, initial.projects[0].live.title);
    assert.equal(state.projects.find(row => row.id === duplicate.id).live.title, '新作品 · 预览专用');
    const previous = await manifest();
    const broken = { ...duplicate.draft, blocks: [{ id: 'broken-image', type: 'image', assetId: 'missing-file', alt: '' }] };
    const failed = app.publisher.start('publish', { settings: state.settingsLive, projects: [broken] }, () => assert.fail('失败构建不应提交数据库'));
    await until(() => failed.status !== 'running', '失败构建结束'); await until(() => !app.publisher.busy, '队列结束');
    assert.equal(failed.status, 'failed'); assert.equal(app.store.get('currentRelease'), publishedRelease); assert.deepEqual(await manifest(), previous);
  });

  await t.test('排序、设置草稿与发布、特殊字符转义', async () => {
    const state = await ok('/api/state'), ids = state.projects.filter(row => !row.deletedAt).map(row => row.id).reverse();
    await ok('/api/reorder', 'POST', { ids });
    assert.deepEqual((await ok('/api/state')).projects.map(row => row.id), ids);
    const settings = { ...state.settings, tagline: '$& {{not-a-template}} <测试>', appearance: { accent: '#1266bb', coverRadius: 7 } };
    await ok('/api/settings', 'PUT', { ...settings, revision: state.settingsRevision });
    assert.equal((await ok('/api/state')).settingsLive.brand, initial.settingsLive.brand);
    await job(await ok('/api/publish', 'POST', { projectIds: [], includeSettings: true }, 202));
    const html = (await request('/site/')).value;
    assert.ok(html.includes('$&amp; &#123;&#123;not-a-template&#125;&#125; &lt;测试&gt;'));
    assert.ok((await request('/site/origami-hero.css')).value.includes('border-radius:7px'));
    const releaseId = (await ok('/api/state')).currentRelease;
    assert.equal((await request(`/history/${releaseId}/`)).response.status, 200);
    assert.equal((await request(`/history/${releaseId}/`, 'GET', undefined, { headers:{Origin:'http://evil.invalid'} })).response.status, 403);
  });

  await t.test('部署包根目录可用，源文件保留作品文件夹，均不携带账号数据库', async () => {
    const release = (await ok('/api/state')).currentRelease;
    for (const kind of ['dist', 'source']) {
      const response = await fetch(`${base}/api/export/${release}?kind=${kind}`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer());
      const files = zipEntries(bytes);
      assert.ok(files.has('index.html'));
      assert.ok(![...files.keys()].some(name => /(^|\/)(node_modules|uploads|releases|portfolio\.sqlite|server\.mjs)(\/|$)/.test(name)));
      if (kind === 'dist') { assert.ok(files.has('data/projects.json')); assert.ok(files.has('assets/vendor/gsap.min.js')); assert.ok(![...files.keys()].some(name => name.endsWith('.md'))); }
      else { assert.ok(files.has('site.json')); assert.ok(files.has('package-lock.json')); assert.ok([...files.keys()].some(name => name.startsWith('Portfolio/') && name.endsWith('/index.md'))); }
      await writeFile(path.join(dataDir, `verified-${kind}.zip`), bytes);
    }
  });

  await t.test('下架、回收站、恢复、永久删除以及历史回退', async () => {
    await job(await ok(`/api/projects/${duplicate.id}/trash`, 'POST', {}, 202));
    let row = (await ok('/api/state')).projects.find(row => row.id === duplicate.id); assert.ok(row.deletedAt); assert.equal(row.live, null);
    await ok(`/api/projects/${duplicate.id}/restore`, 'POST', {});
    row = (await ok('/api/state')).projects.find(row => row.id === duplicate.id); assert.equal(row.deletedAt, null); assert.equal(row.live, null);
    await ok(`/api/projects/${duplicate.id}/trash`, 'POST', {});
    await ok(`/api/projects/${duplicate.id}`, 'DELETE');
    assert.equal((await request(`/api/media/${uploaded.id}`, 'DELETE')).response.status, 409, '已发布历史仍引用素材');
    await job(await ok('/api/rollback', 'POST', { id: publishedRelease }, 202));
    const state = await ok('/api/state'); assert.ok(state.projects.find(row => row.id === duplicate.id)?.live); assert.notEqual(state.currentRelease, publishedRelease);
    assert.equal(state.projects.find(row => row.id === saved.id).draft.title, saved.draft.title, '回退不覆盖当前草稿');
    assert.equal(state.settingsLive.brand, initial.settingsLive.brand);
  });

  await t.test('作品媒体暂存、音视频块、非破坏裁切、范围读取与发布后入库', async () => {
    mediaProject = await ok('/api/projects', 'POST', { title: '媒体块集成检查', category: '三维', description: '图片、视频、音频按块排列', tags: [], blocks: [] }, 201);
    const upload = async (bytes, name, projectId = mediaProject.id) => {
      const response = await fetch(base + '/api/media?name=' + encodeURIComponent(name) + (projectId ? '&projectId=' + projectId : ''), { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: bytes });
      const result = await response.json(); assert.equal(response.status, 201, JSON.stringify(result)); return result;
    };
    const image = await upload(testPng(), '六比四.png'), audio = await upload(testWav(), '测试静音.wav');
    // Container-header fixture checks MP4 detection and packaging, not video decoding.
    const videoBytes = Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d69736f32000000086d646174', 'hex')]);
    const video = await upload(videoBytes, '容器检查.mp4');
    assert.equal(image.library, 0); assert.equal(audio.mime, 'audio/wav'); assert.equal(video.mime, 'video/mp4');
    const state = await ok('/api/state'); assert.equal(state.media.find(asset => asset.id === image.id).library, 0); assert.ok(state.media.find(asset => asset.id === image.id).pendingProjects.includes(mediaProject.id));
    const crop = { x: .22, y: .72, zoom: 1.7 };
    mediaProject = await ok(`/api/projects/${mediaProject.id}`, 'PUT', { ...mediaProject.draft, revision: mediaProject.revision, coverAssetId: image.id, coverRatio: '3:4', coverCrop: crop, blocks: [{ id: 'intro', type: 'text', text: '开始展示' }, { id: 'image', type: 'image', assetId: image.id, alt: '' }, { id: 'video', type: 'video', assetId: video.id, alt: '' }, { id: 'audio', type: 'audio', assetId: audio.id, alt: '' }, { id: 'end', type: 'text', text: '展示结束' }] });
    assert.equal((await request(`/api/projects/${mediaProject.id}`, 'PUT', { ...mediaProject.draft, revision: mediaProject.revision, coverCrop: { ...crop, zoom: 9 } })).response.status, 400);
    assert.equal((await request(`/api/projects/${mediaProject.id}`, 'PUT', { ...mediaProject.draft, revision: mediaProject.revision, blocks: [{ id: 'bad', type: 'image', assetId: audio.id }] })).response.status, 400);
    const range = await fetch(`${base}/api/media/${audio.id}/file`, { headers: { Cookie: cookie, Range: 'bytes=0-11' } });
    assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 0-11/${testWav().length}`); assert.equal((await range.arrayBuffer()).byteLength, 12);
    const preview = await job(await ok('/api/preview', 'POST', {}, 202));
    assert.equal(app.store.asset(image.id).library, 0); assert.equal(app.store.asset(audio.id).library, 0);
    const fragment = (await ok(preview.url + `data/projects/${mediaProject.id}.json`)).html;
    assert.ok(fragment.includes('<video controls playsinline')); assert.ok(fragment.includes('<audio controls')); assert.ok(fragment.indexOf('<video') < fragment.indexOf('<audio')); assert.ok(fragment.indexOf('开始展示') < fragment.indexOf('<video')); assert.ok(fragment.indexOf('展示结束') > fragment.indexOf('<audio'));
    assert.ok((await request(preview.url)).value.includes('object-position:22% 72%;transform:scale(1.7)'));
    await job(await ok('/api/publish', 'POST', { projectIds: [mediaProject.id], includeSettings: false }, 202));
    assert.equal(app.store.asset(image.id).library, 1); assert.equal(app.store.asset(audio.id).library, 1); assert.equal(app.store.asset(video.id).library, 1);
    const manifestRow = (await manifest()).find(row => row.id === mediaProject.id); assert.deepEqual(manifestRow.coverCrop, crop);
    const detail = await ok(`/site/data/projects/${mediaProject.id}.json`), source = detail.html.match(/<audio[^>]+src="([^"]+)"/)[1];
    const publicRange = await fetch(base + '/site/' + source, { headers: { Range: 'bytes=-8' } }); assert.equal(publicRange.status, 206); assert.equal((await publicRange.arrayBuffer()).byteLength, 8);
    const invalidRange = await fetch(base + '/site/' + source, { headers: { Range: 'bytes=99999999-' } }); assert.equal(invalidRange.status, 416);
    const notPublished = await upload(Buffer.concat([testWav(), Buffer.from('distinct')]), '未使用音频.wav'); assert.equal(notPublished.library, 0);
    const direct = await upload(Buffer.concat([testWav(), Buffer.from('distinct')]), '直接入库.wav', null); assert.equal(direct.library, 1, '从素材库主动上传会入库，即使命中暂存文件去重');
    const dbReopened = await openStore(dataDir, path.join(root, 'renderer')); assert.equal(dbReopened.asset(image.id).library, 1); dbReopened.close();
  });

  await t.test('分类标签集中维护；删除分类保留作品并迁移草稿', async () => {
    let state = await ok('/api/state');
    await ok('/api/categories', 'POST', { name: '新的分类', revision: state.settingsRevision });
    state = await ok('/api/state'); assert.ok(state.settings.categories.includes('新的分类')); assert.ok(!state.settingsLive.categories.includes('新的分类'));
    const row = state.projects.find(row => row.id === mediaProject.id);
    await ok(`/api/projects/${row.id}`, 'PUT', { ...row.draft, labels: ['新的分类'], revision: row.revision });
    state = await ok('/api/state'); const beforeRename = state.projects.find(row => row.id === mediaProject.id);
    const renamed = await ok('/api/categories', 'PUT', { name: '新的分类', newName: '重命名分类', revision: state.settingsRevision }); assert.equal(renamed.affected, 1);
    state = await ok('/api/state'); const afterRename = state.projects.find(row => row.id === mediaProject.id);
    assert.deepEqual(afterRename.draft.labels, ['重命名分类']); assert.deepEqual(afterRename.draft.tags, ['重命名分类']); assert.equal(afterRename.draft.category, '重命名分类');
    assert.equal(afterRename.revision, beforeRename.revision + 1); assert.deepEqual(afterRename.live, beforeRename.live);
    assert.ok(state.settings.categories.includes('重命名分类')); assert.ok(!state.settings.categories.includes('新的分类')); assert.ok(!state.settingsLive.categories.includes('重命名分类'));
    assert.equal((await request('/api/categories', 'PUT', { name: '重命名分类', newName: '', revision: state.settingsRevision })).response.status, 400);
    assert.equal((await request('/api/categories', 'PUT', { name: '重命名分类', newName: state.settings.categories.find(name => name !== '重命名分类'), revision: state.settingsRevision })).response.status, 409);
    assert.equal((await request('/api/categories', 'PUT', { name: '重命名分类', newName: '冲突名称', revision: 1 })).response.status, 409);
    await ok('/api/categories', 'PUT', { name: '重命名分类', newName: '新的分类', revision: state.settingsRevision }); state = await ok('/api/state');
    const result = await ok('/api/categories', 'DELETE', { name: '新的分类', revision: state.settingsRevision }); assert.equal(result.affected, 1);
    state = await ok('/api/state');
    assert.equal(state.projects.find(row => row.id === mediaProject.id).draft.category, '未分类'); assert.equal(state.projects.find(row => row.id === mediaProject.id).live.category, '三维');
    assert.deepEqual(state.projects.find(row => row.id === mediaProject.id).draft.labels, []); assert.ok(!state.settings.categories.includes('新的分类'));
    assert.equal((await request('/api/categories', 'POST', { name: '冲突分类', revision: 1 })).response.status, 409);
  });

  await t.test('标签直接输入、失焦保存、双击改名与取消，删除无弹窗并同步草稿', async () => {
    const project = await ok('/api/projects', 'POST', { title: '行内标签操作', labels: ['行内旧标签'], blocks: [] }, 201);
    const window = new Window({ url: base, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } }), errors = [], mutations = [];
    t.after(() => window.happyDOM.abort());
    window.fetch = (url, options = {}) => { if (url === '/api/categories') mutations.push(options.method); return fetch(new URL(url, base), { ...options, headers: { ...options.headers, Cookie: cookie } }); };
    window.addEventListener('error', event => errors.push(event.message));
    window.document.write(await readFile(path.join(root, 'public/index.html'), 'utf8'));
    window.eval((await Promise.all(['media-browser.js', 'editor.js','document-selection.js','document.js','app.js'].map(file => readFile(path.join(root, 'public', file), 'utf8')))).join('\n'));
    const $ = selector => window.document.querySelector(selector), input = () => $('[data-category-editor] input');
    const type = value => { input().value = value; input().dispatchEvent(new window.Event('input', { bubbles: true })); };
    const key = key => input().dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const rename = name => { const chip = $(`[data-action=filter-category][data-category="${name}"]`); chip.click(); chip.click(); assert.ok(chip.isConnected, '单击筛选保留标签DOM供双击'); chip.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true })); };
    await until(() => $('.works-table'), '加载标签');
    $('[data-action=add-category]').click(); assert.ok(input()); assert.equal(window.document.activeElement, input()); assert.equal($('#dialog').open, false);
    type('取消的新标签'); key('Escape'); assert.equal(input(), null); assert.equal(mutations.length, 0);
    $('[data-action=add-category]').click(); type('回车添加'); key('Enter'); input()?.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
    await until(() => $('[data-name="回车添加"]'), '回车新增'); assert.equal(mutations.filter(method => method === 'POST').length, 1, '回车和失焦不会重复保存');
    $('[data-action=add-category]').click(); type('失焦添加'); input().blur(); await until(() => $('[data-name="失焦添加"]'), '失焦新增');
    $('[data-action=add-category]').click(); type('对号添加');
    const done = $('.category-inline-done'); assert.equal(done.getAttribute('aria-label'), '完成输入');
    done.focus(); assert.ok(input(), '焦点移动到对号时继续保留输入状态'); assert.equal($('[data-name="对号添加"]'), null);
    done.click(); await until(() => $('[data-name="对号添加"]'), '点击对号新增');
    rename('行内旧标签'); type('回车添加'); key('Enter'); assert.ok($('.category-inline-error')); assert.equal($('#dialog').open, false); assert.deepEqual(app.store.project(project.id).draft.labels, ['行内旧标签']);
    type('行内新标签'); $('.category-inline-done').click(); await until(() => $('[data-name="行内新标签"]'), '对号改名保存');
    assert.deepEqual(app.store.project(project.id).draft.labels, ['行内新标签']); assert.equal($('[data-category="行内新标签"]').classList.contains('active'), true, '当前筛选跟随改名');
    assert.equal($('[data-name="行内旧标签"]'), null);
    rename('行内新标签'); type('放弃修改'); key('Escape'); assert.ok($('[data-name="行内新标签"]')); assert.equal($('[data-name="放弃修改"]'), null);
    $('[data-action=delete-category][data-name="行内新标签"]').click(); await until(() => !$('[data-name="行内新标签"]'), '直接删除使用中的标签');
    assert.equal($('#dialog').open, false); assert.deepEqual(app.store.project(project.id).draft.labels, []); assert.equal(app.store.project(project.id).draft.category, '未分类');
    for (const name of ['回车添加', '失焦添加', '对号添加']) { $(`[data-action=delete-category][data-name="${name}"]`).click(); await until(() => !$(`[data-name="${name}"]`), '直接删除新增标签'); }
    assert.deepEqual(errors, []); await window.happyDOM.abort();
    await ok(`/api/projects/${project.id}/trash`, 'POST', {}); await ok(`/api/projects/${project.id}`, 'DELETE');
  });

  await t.test('管理页面 DOM 交互：直接进入、编辑保存、素材选择、预览、设置和发布', async () => {
    const errors = [], window = new Window({ url: base, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } });
    t.after(() => window.happyDOM.abort());
    let uiCookie = '';
    window.fetch = async (url, options = {}) => {
      const response = await fetch(new URL(url, base), { ...options, headers: { ...options.headers, Cookie: uiCookie } });
      const setCookie = response.headers.get('set-cookie'); if (setCookie) uiCookie = setCookie.split(';')[0]; return response;
    };
    window.addEventListener('error', event => errors.push(event.message));
    const motions = []; window.gsap = { killTweensOf() {}, fromTo(target, from, to) { motions.push({ target, from, to }); return { kill() {} }; } };
    window.document.write(await readFile(path.join(root, 'public/index.html'), 'utf8'));
    window.eval(await readFile(path.join(root, 'public/media-browser.js'), 'utf8') + '\n' + await readFile(path.join(root, 'public/editor.js'), 'utf8') + '\n' + await readFile(path.join(root, 'public/document-selection.js'), 'utf8') + '\n' + await readFile(path.join(root, 'public/document.js'), 'utf8') + '\n' + await readFile(path.join(root, 'public/app.js'), 'utf8'));
    const $ = selector => window.document.querySelector(selector);
    const click = selector => { assert.ok($(selector), `缺少交互元素 ${selector}`); $(selector).click(); };
    const input = (selector, value) => { assert.ok($(selector), selector); $(selector).value = value; $(selector).dispatchEvent(new window.Event('input', { bubbles: true })); };
    const submit = selector => $(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    const drag = (grip, target) => {
      const transfer = { effectAllowed: '', setData() {} }, parent = target.parentElement;
      for (const node of [...parent.children].filter(node => node.matches('[data-row],[data-block]'))) node.getBoundingClientRect = () => { const i = [...parent.children].indexOf(node), grid = parent.classList.contains('work-cards'); return { top: grid ? Math.floor(i / 3) * 180 : i * 100, left: grid ? i % 3 * 220 : 0, width: 200, height: grid ? 170 : 95, bottom: grid ? Math.floor(i / 3) * 180 + 170 : i * 100 + 95 }; };
      const rect = target.getBoundingClientRect();
      const dispatch = (node, type) => { const event = new window.Event(type, { bubbles: true, cancelable: true }); Object.defineProperties(event, { dataTransfer: { value: transfer }, clientX: { value: rect.left + rect.width - 1 }, clientY: { value: rect.bottom - 1 } }); node.dispatchEvent(event); };
      dispatch(grip, 'dragstart'); dispatch(target, 'dragover'); dispatch(target, 'drop'); dispatch(grip, 'dragend');
    };
    await until(() => $('.works-table'), '作品列表'); assert.ok(window.document.querySelectorAll('tbody tr').length >= 2);
    for(const selector of ['#auth-form','[data-action=account]','[data-action=logout]','.account-row','.mobile-account'])assert.equal($(selector),null);
    assert.ok($('.category-manager')); click('[data-action=add-category]'); input('[data-category-editor] input', '页面新增分类'); submit('[data-category-editor]');
    await until(() => $('[data-action=delete-category][data-name="页面新增分类"]'), '新增分类标签');
    click('[data-action=delete-category][data-name="页面新增分类"]'); await until(() => !$('[data-action=delete-category][data-name="页面新增分类"]'), '直接删除分类'); assert.equal($('#dialog').open, false);
    click('[data-action=edit]'); await until(() => $('[data-field=title]'), '编辑器');
    assert.ok($('.editor-overlay')); assert.ok($('.works-table')); assert.equal($('.layout').inert, true); assert.equal($('.block-head'), null); assert.equal($('[data-field=coverRatio]'), null);
    const editingId = $('.editor-shell [data-block]') && app.store.projects().find(row => row.id === window.document.querySelector('.works-table [data-action=edit]').dataset.id)?.id;
    input('[data-field=title]', '从页面修改的标题'); click('[data-action=save]');
    await until(() => app.store.projects().some(row => row.draft.title === '从页面修改的标题'), '真实保存');
    click('[data-action=doc-append]'); assert.ok($('[data-block-field=text]'));
    input('[data-block-field=text]', '来自可视编辑器的说明');
    const blocks = [...window.document.querySelectorAll('[data-block]')], originalFirst = blocks[0].dataset.block;
    drag(blocks[0].querySelector('[data-block-handle]'), blocks[1]); click('[data-action=save]');
    await until(() => app.store.project(editingId).draft.blocks[1].id === originalFirst, '块拖动保存');
    click('[data-action=doc-label-menu]'); click('.label-option-list button'); assert.ok($('.label-value'));
    click('[data-action=choose-cover]'); assert.ok($('#dialog').open); click('[data-pick]'); click('[data-action=use-media]'); assert.ok($('.crop-stage'));
    click('[data-action=crop-ratio][data-ratio="9:16"]'); click('[data-action=crop-reset]'); const cropStage = $('.crop-stage'); cropStage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 640 }); cropStage.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -Math.log(1.5) / .0015, clientX: 180, clientY: 320 })); click('[data-action=apply-crop]'); assert.equal($('#dialog').open, false);
    assert.ok($('.cover-ratio-label').textContent.includes('9:16'));
    click('[data-action=preview-editor]');
    await until(() => $('.preview-viewport iframe'), '真实预览', 20000); assert.ok($('.preview-viewport iframe').getAttribute('src').startsWith('/preview/'));
    click('[data-action=close-editor]'); await until(() => !$('.editor-overlay'), '返回列表');
    assert.equal(app.store.project(editingId).draft.coverCrop.zoom, 1.5);
    let rows = [...window.document.querySelectorAll('tbody [data-row]')], firstId = rows[0].dataset.row;
    drag(rows[0].querySelector('[data-work-handle]'), rows[1]); await until(() => app.store.projects().filter(row => !row.deletedAt)[1].id === firstId, '列表拖拽保存');
    click('[data-view=cards]'); let cards = [...window.document.querySelectorAll('.work-cards [data-row]')]; const cardId = cards[0].dataset.row;
    assert.equal(cards[0].getAttribute('draggable'), 'true'); assert.equal(cards[0].querySelector('[data-work-handle]'), null); drag(cards[0].querySelector('.work-card-cover'), cards[1]); await until(() => app.store.projects().filter(row => !row.deletedAt)[1].id === cardId, '缩略图拖拽保存');
    assert.ok(motions.some(motion => motion.from.x || motion.from.y), '排序产生位置变化动画');
    click('.work-card [data-action=edit]'); await until(() => $('.editor-overlay'), '再次编辑'); $('.editor-overlay').dispatchEvent(new window.Event('pointerdown', { bubbles: true })); $('.editor-overlay').click(); await until(() => !$('.editor-overlay'), '点击空白关闭');
    click('.work-card [data-action=edit]'); await until(() => $('.editor-overlay'), '再次编辑'); window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await until(() => !$('.editor-overlay'), 'Escape关闭');
    click('[data-view=list]');
    click('#select-all'); assert.ok($('#select-all').checked); assert.ok($('.batchbar'));
    click('[data-nav=settings]'); await until(() => $('[data-setting=tagline]'), '网站设置');
    input('[data-setting=tagline]', '管理页设置草稿'); click('[data-action=save-settings]');
    await until(() => app.store.get('settingsDraft').tagline === '管理页设置草稿', '设置保存');
    click('[data-nav=media]'); await until(() => $('.media-grid'), '素材库');
    click('[data-nav=releases]'); await until(() => $('.release-list'), '发布记录');
    click('[data-action=publish-dialog]'); await until(() => $('#publish-form'), '发布确认');
    assert.ok($('#publish-form [name=settings]').checked); click('[data-action=close-dialog]');
    click('[data-nav=trash]'); await until(() => $('.page-heading h1')?.textContent === '回收站', '回收站');
    assert.deepEqual(errors, []);
    const errorToasts = [...window.document.querySelectorAll('.toast.error')].map(node => node.textContent);
    assert.deepEqual(errorToasts, []);
    await window.happyDOM.abort();
  });

  await t.test('作品管理统计筛选、菜单收起、封面卡片与鼠标拖动，新增置顶并保留手排顺序', async () => {
    const before = app.store.projects().filter(row => !row.deletedAt).map(row => row.id);
    const created = await ok('/api/projects', 'POST', { title: '最新创建排序测试', labels: ['排序测试'], blocks: [] }, 201);
    assert.equal(app.store.projects()[0].id, created.id, '新增置顶');
    const copied = await ok(`/api/projects/${created.id}/duplicate`, 'POST', {}, 201);
    assert.equal(app.store.projects()[0].id, copied.id, '副本也按新建置顶');
    const old = app.store.project(before.at(-1));
    await ok(`/api/projects/${old.id}`, 'PUT', { ...old.draft, revision: old.revision });
    assert.equal(app.store.projects()[0].id, copied.id, '修改旧作品不会按更新时间重新排序');
    const errors = [], window = new Window({ url: base, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } });
    t.after(() => window.happyDOM.abort());
    window.fetch = (url, options = {}) => fetch(new URL(url, base), { ...options, headers: { ...options.headers, Cookie: cookie } });
    window.addEventListener('error', event => errors.push(event.message));
    const motions = []; window.gsap = { killTweensOf() {}, fromTo(node, from) { motions.push(from); } };
    window.document.write(await readFile(path.join(root, 'public/index.html'), 'utf8'));
    const css = window.document.createElement('style'); css.textContent = await readFile(path.join(root, 'public/style.css'), 'utf8'); window.document.head.append(css);
    window.eval((await Promise.all(['media-browser.js', 'editor.js', 'document-selection.js', 'document.js', 'app.js'].map(file => readFile(path.join(root, 'public', file), 'utf8')))).join('\n') + '\nwindow.testSortReady = () => !sortSaving;');
    const $ = selector => window.document.querySelector(selector), $$ = selector => [...window.document.querySelectorAll(selector)];
    await until(() => $('.works-table'), '作品管理加载');
    assert.equal($('.summary-strip'), null);
    const rows = app.store.projects().filter(row => !row.deletedAt), counts = [rows.length, rows.filter(row => row.live).length, rows.filter(row => !row.live).length, rows.filter(row => row.live && JSON.stringify(row.draft) !== JSON.stringify(row.live)).length];
    assert.deepEqual($$('[data-status]').map(node => node.textContent), ['全部作品', '已发布', '草稿', '待更新'].map((name, i) => name + '·' + String(counts[i]).padStart(2, '0')));
    $('[data-status=changed]').click();
    assert.equal($$('[data-row]').length, counts[3]);
    $('[data-status=all]').click();
    const menu = $('details.menu'); menu.open = true; $('.page-heading h1').click(); assert.equal(menu.open, false, '空白区域关闭菜单');
    const deleteStyle = window.getComputedStyle($('.category-delete'));
    assert.equal(deleteStyle.display, 'grid'); assert.equal(deleteStyle.placeItems, 'center'); assert.equal(deleteStyle.padding, '0px');
    const geometry = () => {
      const nodes = $$('[data-row]'), parent = nodes[0].parentElement, grid = parent.classList.contains('work-cards');
      nodes.forEach(node => { node.getBoundingClientRect = () => { const i = [...parent.children].indexOf(node), left = grid ? i % 3 * 240 : 0, top = 100 + (grid ? Math.floor(i / 3) * 190 : i * 100); return { left, right: left + 220, top, bottom: top + (grid ? 175 : 95), width: 220, height: grid ? 175 : 95 }; }; });
      return nodes;
    };
    const pointer = (node, type, x, y) => node.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 0, clientX: x, clientY: y }));
    const drag = async (surface, target, cancel = false) => {
      const start = surface.closest('[data-row]').getBoundingClientRect(), end = target.getBoundingClientRect();
      pointer(surface, 'pointerdown', start.left + 15, start.top + 25);
      pointer(window.document, 'pointermove', end.right - 10, end.bottom - 10);
      if (cancel) window.document.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
      else { pointer(window.document, 'pointerup', end.right - 10, end.bottom - 10); await until(() => !window.document.body.classList.contains('block-dragging') && !$('#block-drag-preview') && app.store.projects().filter(row => !row.deletedAt)[1].id === copied.id, '鼠标拖动保存'); }
    };
    let nodes = geometry(); await drag(nodes[0].querySelector('[data-work-handle]'), nodes[1]);
    await until(() => window.testSortReady(), '排序请求结束');
    assert.equal(app.store.projects()[1].id, copied.id, '列表鼠标手柄拖动');
    await until(() => $('[data-view=cards]'), '列表重新加载'); $('[data-view=cards]').click(); nodes = geometry();
    assert.ok(nodes.every(node => node.querySelector('.work-card-cover') && node.querySelector('.work-card-caption .work-card-labels') && node.querySelector('.work-card-title') && node.querySelector('.work-card-state') && node.querySelector('.work-card-edit[data-action=edit]')));
    assert.equal(nodes[0].querySelector('.work-card-cover').parentElement.tagName, 'ARTICLE');
    assert.equal(window.getComputedStyle(nodes[0].querySelector('.work-card-cover')).position, 'absolute');
    const originalOrder = nodes.map(node => node.dataset.row);
    await drag(nodes[0].querySelector('.work-card-cover'), nodes[1], true);
    assert.deepEqual($$('[data-row]').map(node => node.dataset.row), originalOrder, '取消拖动恢复位置');
    // Move the second card back before the first using the whole cover surface.
    nodes = geometry(); const start = nodes[1].getBoundingClientRect(), end = nodes[0].getBoundingClientRect();
    pointer(nodes[1].querySelector('.work-card-cover'), 'pointerdown', start.left + 30, start.top + 30);
    pointer(window.document, 'pointermove', end.left + 20, end.top + 30);
    pointer(window.document, 'pointerup', end.left + 20, end.top + 30);
    await until(() => app.store.projects()[0].id === copied.id && !$('#block-drag-preview') && window.testSortReady(), '直接拖动缩略图保存');
    assert.ok(motions.some(from => from.x || from.y), '排序有位移动画');
    const hiddenBefore = app.store.projects().filter(row => !row.deletedAt && ![copied.id, created.id].includes(row.id)).map(row => row.id);
    $('[data-action=filter-category][data-category="排序测试"]').click(); nodes = geometry(); assert.equal(nodes.length, 2);
    await drag(nodes[0].querySelector('.work-card-cover'), nodes[1]); await until(() => window.testSortReady(), '筛选排序结束');
    assert.equal(app.store.projects()[0].id, created.id);
    assert.deepEqual(app.store.projects().filter(row => !row.deletedAt && ![copied.id, created.id].includes(row.id)).map(row => row.id), hiddenBefore, '筛选排序保留隐藏作品顺序');
    $('[data-action=filter-category][data-category=""]').click();
    await until(() => $('.work-card-edit'), '卡片重绘'); $('.work-card-edit').click(); await until(() => $('.editor-overlay'), '独立编辑按钮打开编辑器');
    $('[data-action=close-editor]').click(); await until(() => !$('.editor-overlay'), '退出编辑');
    assert.deepEqual(errors, []);
    await window.happyDOM.abort();
    const readAgain = await openStore(dataDir, path.join(root, 'renderer'));
    assert.equal(readAgain.projects()[0].id, created.id, '手动顺序持久化'); readAgain.close();
    for (const id of [created.id, copied.id]) { await ok(`/api/projects/${id}/trash`, 'POST', {}); await ok(`/api/projects/${id}`, 'DELETE'); }
    await ok('/api/reorder', 'POST', { ids: before });
  });

  await t.test('作品复选框与多选模式，两种视图成组排序、目标接缝指示、取消及顺序持久化', async () => {
    const before = app.store.projects().filter(row => !row.deletedAt).map(row => row.id), fixtures = [];
    for (let i = 0; i < 5; i++) fixtures.push(await ok('/api/projects', 'POST', { title: `批量排序-${i}`, labels: ['批量排序'], blocks: [] }, 201));
    const window = new Window({ url: base, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } }), errors = [];
    t.after(() => window.happyDOM.abort()); window.fetch = (url, options = {}) => fetch(new URL(url, base), { ...options, headers: { ...options.headers, Cookie: cookie } }); window.addEventListener('error', event => errors.push(event.message));
    window.document.write(await readFile(path.join(root, 'public/index.html'), 'utf8'));
    const css = window.document.createElement('style'); css.textContent = await readFile(path.join(root, 'public/style.css'), 'utf8'); window.document.head.append(css);
    window.eval((await Promise.all(['media-browser.js', 'editor.js','document-selection.js','document.js','app.js'].map(file => readFile(path.join(root, 'public', file), 'utf8')))).join('\n') + '\nwindow.testWorkDrag = { ready: () => !sortSaving, selection: () => [...selected] };');
    const $ = selector => window.document.querySelector(selector), $$ = selector => [...window.document.querySelectorAll(selector)];
    await until(() => $('.works-table'), '作品管理');
    const order = () => $$('[data-row]').map(node => node.dataset.row);
    const geometry = () => { const nodes = $$('[data-row]'), parent = nodes[0].parentElement, grid = parent.classList.contains('work-cards'); nodes.forEach(node => { node.getBoundingClientRect = () => { const i = [...parent.children].indexOf(node), left = grid ? i % 3 * 240 : 0, top = 100 + (grid ? Math.floor(i / 3) * 190 : i * 100), height = grid ? 175 : 95; return { left, right: left + 220, top, bottom: top + height, width: 220, height }; }; }); return nodes; };
    const pointer = (node, type, x, y) => node.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 19, pointerType: 'mouse', button: 0, clientX: x, clientY: y }));
    const beginDrag = (source, target, grid = false) => { const a = source.getBoundingClientRect(), b = target.getBoundingClientRect(); pointer(grid ? source.querySelector('.work-card-cover') : source.querySelector('[data-work-handle]'), 'pointerdown', a.left + 15, a.top + 25); pointer(window.document, 'pointermove', b.right - 15, b.bottom - 15); return b; };
    const endDrag = async rect => { pointer(window.document, 'pointerup', rect.right - 15, rect.bottom - 15); await until(() => window.testWorkDrag.ready(), '排序保存'); assert.equal($('#block-drop-marker'), null); };
    const choose = id => $(`[data-select="${id}"]`).click();
    let ids = order(); choose(ids[0]); choose(ids[2]); assert.ok($('.batchbar').textContent.includes('2'));
    let nodes = geometry(), expected = [ids[1],ids[3],ids[4],ids[0],ids[2],...ids.slice(5)], end = beginDrag(nodes[2], nodes[4]);
    assert.deepEqual(order(), expected, '列表从任意所选手柄拖动整个组，保留组内顺序'); assert.equal($('#block-drag-preview').textContent, '移动 2 件作品');
    await endDrag(end); assert.deepEqual(app.store.projects().filter(row => !row.deletedAt).map(row => row.id), expected); assert.deepEqual(Array.from(window.testWorkDrag.selection()), [ids[0],ids[2]]);
    $('[data-view=cards]').click(); assert.ok($('.work-cards.is-selecting')); assert.equal($$('.work-card input:checked').length, 2, '跨视图保留选择');
    $('[data-action=clear-selection]').click(); assert.equal(window.getComputedStyle($('.work-card-select')).opacity, '0', '未悬停时隐藏复选框');
    ids = order(); choose(ids[0]); choose(ids[2]); assert.equal(window.getComputedStyle($('.work-card-select')).opacity, '1', '进入多选模式后复选框保持可用');
    // Clicking another cover in selection mode toggles its selection.
    await delay(360); $(`[data-row="${ids[3]}"] .work-card-cover`).click(); assert.equal(Array.from(window.testWorkDrag.selection()).length, 3); choose(ids[3]);
    assert.equal(window.getComputedStyle($('.work-card-edit')).backgroundColor, window.getComputedStyle($('.work-card-state .status')).backgroundColor, '编辑按钮使用与状态框相同的半透明背景');
    nodes = geometry(); const selectionBefore = Array.from(window.testWorkDrag.selection()); end = beginDrag(nodes[0], nodes[4], true);
    const marker = $('#block-drop-marker'), target = nodes[4], rect = target.getBoundingClientRect();
    assert.equal(marker.hidden, false); assert.equal(marker.dataset.target, ids[4]); assert.equal(marker.dataset.side, 'after');
    assert.equal(marker.style.width, '2px'); assert.equal(marker.style.height, '175px'); assert.equal(parseFloat(marker.style.left), rect.right + 8, '蓝线位于目标右侧接缝，不在源卡片顶部');
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })); assert.deepEqual(order(), ids); assert.deepEqual(Array.from(window.testWorkDrag.selection()), selectionBefore); assert.equal($('#block-drop-marker'), null);
    nodes = geometry(); expected = [ids[1],ids[3],ids[4],ids[0],ids[2],...ids.slice(5)]; end = beginDrag(nodes[2], nodes[4], true); await endDrag(end);
    assert.deepEqual(order(), expected); assert.deepEqual(app.store.projects().filter(row => !row.deletedAt).map(row => row.id), expected, '卡片跨行成组排序保存');
    // The click produced at the end of dragging must not toggle selection.
    $(`[data-row="${ids[2]}"] .work-card-cover`).click(); assert.deepEqual(Array.from(window.testWorkDrag.selection()), selectionBefore);
    const reopened = await openStore(dataDir, path.join(root, 'renderer')); assert.deepEqual(reopened.projects().filter(row => !row.deletedAt).map(row => row.id), expected); reopened.close();
    // The native drag fallback shares the same work group logic.
    nodes = geometry(); const source = nodes.find(node => node.dataset.row === ids[0]), destination = nodes[0], transfer = { effectAllowed: '', setData() {} };
    for (const [node,type] of [[source,'dragstart'],[destination,'dragover']]) { const e = new window.Event(type, { bubbles:true,cancelable:true }); Object.defineProperties(e,{dataTransfer:{value:transfer},clientX:{value:5},clientY:{value:110}}); node.dispatchEvent(e); }
    assert.equal($$('.sorting-source').length, 2); assert.equal($('#block-drop-marker').dataset.side, 'before');
    source.dispatchEvent(new window.Event('dragend',{bubbles:true})); assert.deepEqual(order(), expected); assert.equal($('#block-drop-marker'), null);
    assert.deepEqual(errors, []); await window.happyDOM.abort();
    for (const row of fixtures) { await ok(`/api/projects/${row.id}/trash`, 'POST', {}); await ok(`/api/projects/${row.id}`, 'DELETE'); }
    await ok('/api/reorder', 'POST', { ids: before });
  });

  await t.test('文档式编辑：默认文字、分段与合并、斜杠菜单、光标插入、统一多标签', async () => {
    const window = new Window({ url: base, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } });
    t.after(() => window.happyDOM.abort()); const errors = [];
    window.fetch = (url, options = {}) => fetch(new URL(url, base), { ...options, headers: { ...options.headers, Cookie: cookie } });
    window.addEventListener('error', event => errors.push(event.message));
    window.document.write(await readFile(path.join(root, 'public/index.html'), 'utf8'));
    window.eval((await Promise.all(['media-browser.js', 'editor.js', 'document-selection.js', 'document.js', 'app.js'].map(file => readFile(path.join(root, 'public', file), 'utf8')))).join('\n'));
    const $ = selector => window.document.querySelector(selector), $$ = selector => [...window.document.querySelectorAll(selector)];
    const click = selector => { assert.ok($(selector), selector); $(selector).click(); };
    const type = (selector, value) => { const node = typeof selector === 'string' ? $(selector) : selector; assert.ok(node); node.focus(); node.value = value; node.dispatchEvent(new window.Event('input', { bubbles: true })); return node; };
    const key = (node, value, modifiers = {}) => { const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...modifiers }); node.dispatchEvent(event); return event; };
    const texts = () => $$('[data-block-field=text]');
    await until(() => $('.works-table'), '直接进入作品列表'); click('[data-action=new]'); await until(() => $('.document-title'), '新建作品文档');
    assert.equal($$('[data-block]').length, 1); assert.equal(texts().length, 1); assert.equal(texts()[0].value, '');
    assert.ok($('.document-editor [data-field=title]')); assert.ok($('.document-editor [data-field=description]')); assert.equal($('[data-field=category]'), null); assert.equal($('[data-field=tags]'), null);
    assert.ok($('.document-sidebar .document-cover')); assert.ok($('.document-sidebar .document-preview')); assert.equal($('.panel-tabs'), null);
    type('[data-field=title]', '文档式作品检查'); type('[data-field=description]', '简介位于标签下方');
    click('[data-action=doc-label-menu]'); const optionNames = $$('.label-option-list [data-name]').slice(0, 2).map(node => node.dataset.name);
    for (const name of optionNames) $$('.label-option-list [data-name]').find(node => node.dataset.name === name).click();
    assert.equal($$('.label-value .document-label').length, 2); assert.ok($('.label-options'));
    key($('#document-label-search'), 'Escape'); assert.equal($('.label-options'), null); assert.ok($('.editor-overlay'));
    let node = type(texts()[0], '前段后段'); node.setSelectionRange(2, 2); assert.equal(key(node, 'Enter').defaultPrevented, true);
    assert.deepEqual(texts().map(node => node.value), ['前段', '后段']); assert.equal(window.document.activeElement, texts()[1]);
    node = texts()[1]; assert.equal(key(node, 'Enter', { shiftKey: true }).defaultPrevented, false);
    type(node, '后段\n续行'); assert.equal(texts().length, 2); node.setSelectionRange(0, 0); key(node, 'Backspace');
    assert.deepEqual(texts().map(node => node.value), ['前段后段\n续行']);
    click('[data-action=doc-append]'); node = texts().at(-1); assert.equal(node.value, ''); key(node, '/'); assert.ok($('#block-type-menu')); assert.equal(node.value, '');
    key($('#block-type-menu button'), 'Escape'); assert.equal($('#block-type-menu'), null); assert.ok($('.editor-overlay'));
    const lastId = texts().at(-1).dataset.blockId; click(`[data-block-handle][data-block-id="${lastId}"]`); assert.ok($('#block-type-menu'));
    click('#block-type-menu [data-format=h2]'); assert.equal(texts().at(-1).value, '## '); assert.ok($('.md-h2'));
    node = texts().at(-1); node.setSelectionRange(node.value.length, node.value.length); key(node, 'Enter'); node = texts().at(-1); const convertingId = node.dataset.blockId; key(node, '/');
    click('#block-type-menu [data-type=image]'); assert.ok($('#dialog').open); click('[data-pick]'); click('[data-action=use-media]');
    assert.ok($(`[data-block="${convertingId}"]>img`)); assert.ok(texts().at(-1).value === '');
    // Media toolbar insertion preserves both sides of the active text caret.
    node = type(texts()[0], '左边右边'); node.setSelectionRange(2, 2); const insertionId = node.dataset.blockId;
    $('[data-action=add-images]').dispatchEvent(new window.Event('pointerdown', { bubbles: true })); click('[data-action=add-images]'); click('[data-pick]'); click('[data-action=use-media]');
    const blocks = $$('[data-block]'); assert.equal(blocks[0].dataset.block, insertionId); assert.equal(blocks[0].querySelector('textarea').value, '左边'); assert.ok(blocks[1].querySelector('img')); assert.equal(blocks[2].querySelector('textarea').value, '右边');
    type(texts().at(-1), '同一段\n第二行');
    click('[data-action=save]'); await until(() => app.store.projects().some(row => row.draft.title === '文档式作品检查' && row.draft.blocks[0].text === '左边'), '保存文档数据');
    let row = app.store.projects().find(row => row.draft.title === '文档式作品检查'); assert.deepEqual(row.draft.labels, optionNames); assert.deepEqual(row.draft.tags, optionNames); assert.equal(row.draft.description, '简介位于标签下方');
    click('[data-action=close-editor]'); await until(() => !$('.editor-overlay'), '关闭并保存文档');
    await job(await ok('/api/publish', 'POST', { projectIds: [row.id], includeSettings: false }, 202));
    const item = (await manifest()).find(project => project.id === row.id); assert.deepEqual(item.labels, optionNames);
    const html = (await request('/site/')).value; for (const label of optionNames) assert.ok(html.includes(`data-category="${label}"`), `展示站标签 ${label}`);
    const fragment = (await ok(`/site/data/projects/${row.id}.json`)).html; assert.ok(fragment.includes('左边')); assert.ok(fragment.includes('右边')); assert.ok(fragment.includes('<h2>'));
    assert.ok(fragment.includes('同一段<br>\n第二行'), '块内换行在展示站保持可见');
    click(`[data-action=edit][data-id="${row.id}"]`); await until(() => $('.document-title'), '重新打开文档');
    assert.equal($('[data-field=title]').value, '文档式作品检查'); assert.equal($$('[data-block]')[1].querySelector('img') !== null, true); assert.equal($$('.label-value .document-label').length, 2);
    click('[data-action=close-editor]'); await until(() => !$('.editor-overlay'), '关闭重新打开的文档');
    assert.deepEqual(errors, []); assert.deepEqual($$('.toast.error').map(node => node.textContent), []);
    await window.happyDOM.abort();
  });

  await t.test('实际富文本内核接入文档：分块、格式光标插图、保存重开和发布一致', async () => {
    const window = new Window({ url: base, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } });
    Object.defineProperty(window.navigator, 'platform', { value: 'Win32' });
    t.after(async () => { window.PortfolioRichText?.destroyAll(); await window.happyDOM.abort(); });
    const errors = []; window.addEventListener('error', event => errors.push(event.message));
    window.fetch = (url, options = {}) => fetch(new URL(url, base), { ...options, headers: { ...options.headers, Cookie: cookie } });
    window.document.write(await readFile(path.join(root, 'public/index.html'), 'utf8'));
    window.eval(await readFile(path.join(root, 'public/rich-text.bundle.js'), 'utf8'));
    window.eval((await Promise.all(['media-browser.js', 'editor.js', 'document-selection.js', 'document.js', 'app.js'].map(file => readFile(path.join(root, 'public', file), 'utf8')))).join('\n'));
    const $ = selector => window.document.querySelector(selector), $$ = selector => [...window.document.querySelectorAll(selector)];
    const click = selector => { assert.ok($(selector), selector); $(selector).click(); };
    const rich = (index = -1) => window.PortfolioRichText.get($$('[data-block-field=text]').at(index).dataset.blockId);
    const type = (instance, value) => { for (const char of value) { const { from, to } = instance.state.selection; let handled = false; instance.view.someProp('handleTextInput', handler => { if (handler(instance.view, from, to, char)) { handled = true; return true; } }); if (!handled) instance.view.dispatch(instance.state.tr.insertText(char, from, to)); } };
    const key = (instance, value, modifiers = {}) => instance.view.dom.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...modifiers }));
    await until(() => $('.works-table'), '进入列表'); click('[data-action=new]'); await until(() => $('.rich-editor'), '富文本编辑器');
    $('[data-field=title]').value = '富文本保存和发布检查'; $('[data-field=title]').dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal($('[data-block-field=text]').hidden, true);
    type(rich(), '# 标题'); assert.ok($('.rich-editor h1')); assert.ok($('.content-block.rich-mode'));
    key(rich(), 'Enter'); assert.equal($$('[data-block]').length, 2);
    type(rich(), '- 第一项'); key(rich(), 'Enter'); assert.equal($$('[data-block]').length, 3); assert.ok(rich().view.dom.querySelector('li'), '新块仍为项目符号'); type(rich(), '第二项'); key(rich(), 'Tab');
    assert.equal($$('[data-block]').at(-1).dataset.indent, '1'); key(rich(), 'Tab', { shiftKey: true }); assert.equal($$('[data-block]').at(-1).dataset.indent, '0');
    key(rich(), 'Enter', { ctrlKey: true }); type(rich(), '[]已完成'); $('.rich-editor input[type=checkbox]').click();
    assert.ok(rich().getMarkdown().includes('[x]'));
    key(rich(), 'Enter', { ctrlKey: true }); type(rich(), '**左右**'); rich().commands.setTextSelection(2);
    // Actual media picker uses the saved ProseMirror caret, preserving marks on both sides.
    $('[data-action=add-images]').dispatchEvent(new window.Event('pointerdown', { bubbles: true })); click('[data-action=add-images]'); click('[data-pick]'); click('[data-action=use-media]');
    let texts = $$('[data-block-field=text]'); assert.equal(texts.at(-2).value, '**左**'); assert.equal(texts.at(-1).value, '**右**'); assert.ok($$('[data-block]').at(-2).querySelector('img'));
    click('[data-action=doc-append]'); type(rich(), '```'); assert.ok(rich().view.dom.querySelector('pre')); type(rich(), 'let x = 1;'); key(rich(), 'Enter'); type(rich(), 'x++;');
    assert.ok(rich().getMarkdown().includes('let x = 1;\nx++;')); key(rich(), 'Enter', { ctrlKey: true }); type(rich(), '++下划线++ ~删除线~ `行内`');
    click('[data-action=save]'); await until(() => app.store.projects().some(row => row.draft.title === '富文本保存和发布检查' && row.draft.blocks.at(-1).text.includes('下划线')), '保存富文本草稿');
    const row = app.store.projects().find(row => row.draft.title === '富文本保存和发布检查');
    assert.ok(row.draft.blocks.some(block => block.text?.includes('[x]'))); assert.ok(row.draft.blocks.some(block => block.text?.includes('```')));
    click('[data-action=preview-editor]'); await until(() => $('.preview-viewport iframe'), '富文本预览');
    const previewURL = $('.preview-viewport iframe').getAttribute('src').split(/[?#]/)[0];
    const preview = (await ok(previewURL + `data/projects/${row.id}.json`)).html;
    assert.ok(preview.includes('<u>下划线</u>')); assert.ok(preview.includes('type="checkbox"')); assert.ok(preview.includes('<pre><code>'));
    click('[data-action=close-editor]'); await until(() => !$('.editor-overlay'), '关闭富文本');
    click(`[data-action=edit][data-id="${row.id}"]`); await until(() => $('.rich-editor input[type=checkbox]'), '重新打开富文本');
    assert.ok($('.rich-editor h1')); assert.equal($('.rich-editor input[type=checkbox]').checked, true); assert.ok($('.rich-editor u')); assert.ok($('.rich-editor pre')); assert.ok($('.rich-editor s'));
    // Type-menu conversions are also rich editing, with no visible Markdown prefix.
    click('[data-action=doc-append]'); const lastId = $$('[data-block-field=text]').at(-1).dataset.blockId;
    click(`[data-block-handle][data-block-id="${lastId}"]`); click('#block-type-menu [data-format=task]'); assert.ok(rich().view.dom.querySelector('input[type=checkbox]'));
    type(rich(), '新任务'); key(rich(), 'Enter'); assert.ok(rich().view.dom.querySelector('input[type=checkbox]')); assert.equal(rich().view.dom.querySelector('input[type=checkbox]').checked, false);
    key(rich(), 'Enter'); assert.equal(rich().view.dom.querySelector('input[type=checkbox]'), null, '空待办回车退出为正文');
    type(rich(), '1. 第一条'); key(rich(), 'Enter'); assert.equal(rich().view.dom.querySelector('ol').getAttribute('start'), '2'); type(rich(), '第二条');
    key(rich(), 'Enter'); assert.equal(rich().view.dom.querySelector('ol').getAttribute('start'), '3'); key(rich(), 'Enter'); assert.equal(rich().view.dom.querySelector('ol'), null);
    click('[data-action=add-table]'); assert.ok(rich().view.dom.querySelector('table')); assert.equal(rich().view.dom.querySelectorAll('tr').length, 3); assert.equal(rich().view.dom.querySelectorAll('th').length, 0); assert.equal(rich().view.dom.querySelectorAll('td').length, 9); assert.equal(rich().view.dom.textContent, '');
    const tableId = $$('[data-block-field=text]').at(-1).dataset.blockId;
    assert.equal($('.table-controls'), null);
    click(`[data-block="${tableId}"] [data-table-edge=row]`); assert.equal(rich().view.dom.querySelectorAll('tr').length, 4);
    click(`[data-block="${tableId}"] [data-table-edge=column]`); assert.equal(rich().view.dom.querySelector('tr').children.length, 4);
    type(rich(), '表格内容'); key(rich(), 'Enter'); assert.equal($$('[data-block-field=text]').at(-1).dataset.blockId, tableId, '单元格回车留在表格');
    click(`[data-block="${tableId}"] [data-table-axis=column]`); assert.equal($('.table-axis-menu button').textContent.trim(), 'H标题列'); click('[data-table-command=toggle-header]'); assert.equal(rich().view.dom.querySelectorAll('th').length, 4);
    click(`[data-block="${tableId}"] [data-table-axis=row]`); click('[data-table-command=toggle-header]'); assert.equal(rich().view.dom.querySelectorAll('th').length, 7); assert.ok(rich().view.dom.querySelector('table').textContent.includes('表格内容'));
    const pointer = (node, type, x, y, modifiers = {}) => node.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 0, clientX: x, clientY: y, ...modifiers }));
    const prepareGeometry = () => { const parent = $('#block-list'); $$('[data-block]').forEach(node => { node.getBoundingClientRect = () => { const index = [...parent.children].indexOf(node); return { top: 100 + index * 70, bottom: 160 + index * 70, left: 100, right: 600, width: 500, height: 60 }; }; }); };
    // Drag the gutter handle with the mouse; the pointer never enters content.
    const image = $('[data-block].image'); image.querySelector('img').click(); assert.ok(image.classList.contains('is-selected'));
    const imageId = image.dataset.block; prepareGeometry(); const rect = image.getBoundingClientRect(), grip = image.querySelector('[data-block-handle]');
    pointer(grip, 'pointerdown', 78, rect.top + 16); pointer(grip, 'pointermove', 78, 102); assert.ok($('#block-drag-preview')); pointer(grip, 'pointerup', 78, 102);
    assert.equal($$('[data-block]')[0].dataset.block, imageId); assert.equal($('#block-drag-preview'), null); assert.ok($('[data-block].image').classList.contains('is-selected'));
    const movePointer = (source, target, after = false) => { prepareGeometry(); const a = source.getBoundingClientRect(), b = target.getBoundingClientRect(), handle = source.querySelector('[data-block-handle]'); pointer(handle, 'pointerdown', 78, a.top + 16); pointer(handle, 'pointermove', 78, after ? b.bottom - 2 : b.top + 2); pointer(handle, 'pointerup', 78, after ? b.bottom - 2 : b.top + 2); };
    movePointer($(`[data-block="${tableId}"]`), $$('[data-block]')[1], true); assert.equal($$('[data-block]')[2].dataset.block, tableId); assert.ok($(`[data-block="${tableId}"] .rich-editor table`).textContent.includes('表格内容'));
    let orderedNodes = $$('[data-block]').filter(node => /^\d+\. /.test(node.querySelector('textarea')?.value)); const oldSecondId = orderedNodes[1].dataset.block;
    movePointer(orderedNodes[1], orderedNodes[0]); orderedNodes = $$('[data-block]').filter(node => /^\d+\. /.test(node.querySelector('textarea')?.value));
    assert.equal(orderedNodes[0].dataset.block, oldSecondId); assert.ok(orderedNodes[0].querySelector('textarea').value.startsWith('1. ')); assert.ok(orderedNodes[1].querySelector('textarea').value.startsWith('2. '));
    // Native/legacy events consumed by rich editors must not prevent capture-phase sorting.
    for (const [action, kind] of [['add-video','video'],['add-audio','audio']]) {
      click(`[data-action=${action}]`); click('[data-pick]'); click('[data-action=use-media]'); const mediaNode = $(`[data-block].${kind}`); mediaNode.querySelector(kind).click(); assert.ok(mediaNode.classList.contains('is-selected'));
    }
    // Cancel a pointer drag without reordering or closing the editor.
    prepareGeometry(); const beforeCancel = $$('[data-block]').map(node => node.dataset.block), firstGrip = $$('[data-block]')[0].querySelector('[data-block-handle]');
    pointer(firstGrip, 'pointerdown', 78, 116); pointer(firstGrip, 'pointermove', 78, 260); window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.deepEqual($$('[data-block]').map(node => node.dataset.block), beforeCancel); assert.ok($('.editor-overlay')); assert.equal($('#block-drag-preview'), null);
    click('[data-action=close-editor]'); await until(() => !$('.editor-overlay'), '关闭重开检查');
    const updated = app.store.project(row.id); assert.equal(updated.draft.blocks[0].id, imageId); assert.ok(updated.draft.blocks.some(block => block.type === 'table' && block.text.includes('表格内容')));
    click(`[data-action=edit][data-id="${row.id}"]`); await until(() => $('.rich-editor table'), '表格保存后重开'); assert.ok($('.rich-editor table').textContent.includes('表格内容')); assert.equal($('.rich-editor table').querySelectorAll('tr').length, 4); assert.equal($('.rich-editor table').querySelectorAll('th').length, 7); click('[data-action=close-editor]'); await until(() => !$('.editor-overlay'), '关闭表格检查');
    await job(await ok('/api/publish', 'POST', { projectIds: [row.id], includeSettings: false }, 202));
    const fragment = (await ok(`/site/data/projects/${row.id}.json`)).html;
    assert.ok(fragment.includes('<h1>标题</h1>')); assert.ok(fragment.includes('<strong>左</strong>')); assert.ok(fragment.includes('<strong>右</strong>')); assert.ok(fragment.includes('checked=""')); assert.ok(fragment.includes('<u>下划线</u>')); assert.ok(fragment.includes('<code>行内</code>'));
    assert.ok(fragment.includes('<table>')); assert.ok(fragment.includes('表格内容')); assert.ok(fragment.includes('<video controls')); assert.ok(fragment.includes('<audio controls'));
    assert.ok(fragment.includes('scope="col"')); assert.ok(fragment.includes('scope="row"')); assert.equal((fragment.match(/<tr>/g) || []).length, 4); assert.ok(!fragment.includes('portfolio-table'));
    assert.deepEqual(errors, []); assert.deepEqual($$('.toast.error').map(node => node.textContent), []);
    await window.happyDOM.abort();
  });

  await t.test('手柄选中删除、空表格缩减、吸顶工具栏与相对光标或选中块插入正文', async () => {
    const media = (await ok('/api/state')).media;
    const blocks = [
      { id: 'plain', type: 'text', text: '普通文本' }, { id: 'heading', type: 'text', text: '# 标题' },
      { id: 'bullet', type: 'text', text: '- 项目符号' }, { id: 'task', type: 'text', text: '- [ ] 待办' },
      { id: 'code', type: 'text', text: '```js\nconst n = 1;\n```' },
      { id: 'table', type: 'table', text: '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |' },
      ...['image','video','audio'].map(kind => ({ id: kind, type: kind, assetId: media.find(asset => asset.mime.startsWith(kind + '/')).id, alt: '' })),
    ];
    const project = await ok('/api/projects', 'POST', { title: '块选择和工具栏检查', labels: [], blocks }, 201);
    const window = new Window({ url: base, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } });
    const errors = [], observers = []; Object.defineProperty(window.navigator, 'platform', { value: 'Win32' });
    window.ResizeObserver = class { constructor(callback) { this.callback = callback; observers.push(this); } observe(node) { this.node = node; } disconnect() { this.node = null; } };
    t.after(async () => { window.PortfolioRichText?.destroyAll(); await window.happyDOM.abort(); });
    window.fetch = (url, options = {}) => fetch(new URL(url, base), { ...options, headers: { ...options.headers, Cookie: cookie } });
    window.addEventListener('error', event => errors.push(event.message)); window.document.write(await readFile(path.join(root, 'public/index.html'), 'utf8'));
    const css = window.document.createElement('style'); css.textContent = await readFile(path.join(root, 'public/style.css'), 'utf8'); window.document.head.append(css);
    window.eval(await readFile(path.join(root, 'public/rich-text.bundle.js'), 'utf8'));
    window.eval((await Promise.all(['media-browser.js', 'editor.js','document-selection.js','document.js','app.js'].map(file => readFile(path.join(root, 'public', file), 'utf8')))).join('\n'));
    const $ = selector => window.document.querySelector(selector), $$ = selector => [...window.document.querySelectorAll(selector)];
    const click = selector => { assert.ok($(selector), selector); $(selector).click(); }, block = id => $(`[data-block="${id}"]`), rich = id => window.PortfolioRichText.get(id);
    const key = (node, value) => { const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }); node.dispatchEvent(event); return event; };
    const pointer = (node, type, x, y) => node.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 33, pointerType: 'mouse', button: 0, clientX: x, clientY: y }));
    await until(() => $('.works-table'), '列表'); click(`[data-action=edit][data-id="${project.id}"]`); await until(() => block('table'), '打开编辑器');
    assert.equal(block('table').querySelector('table').textContent.trim(), '', '旧版默认列名只在未填写的空表格中清理');
    assert.ok(app.store.project(project.id).draft.blocks.find(item => item.id === 'table').text.includes('列 1'), '打开时不直接改写保存数据');
    assert.equal(window.getComputedStyle($('.document-toolbar')).position, 'sticky'); assert.ok($('.document-toolbar [data-action=doc-insert-before]')); assert.ok($('.document-toolbar [data-action=doc-insert-after]'));
    const observer = observers.findLast(item => item.node); observer.node.getBoundingClientRect = () => ({ height: 123 }); observer.callback(); assert.equal($('.editor-shell').style.getPropertyValue('--editor-heading-height'), '123px');
    const edge = block('table').querySelector('[data-table-edge=column]'); pointer(edge, 'pointerdown', 300, 100); pointer(edge, 'pointermove', 0, 100); pointer(edge, 'pointerup', 0, 100);
    assert.equal(block('table').querySelector('tr').cells.length, 1); assert.equal(block('table').querySelector('.table-ui').dataset.blocked, undefined);
    // Selected blocks stay anchored when a toolbar click closes the type menu.
    click('[data-block="image"] [data-block-handle]'); assert.ok(block('image').classList.contains('is-selected')); click('[data-action=doc-insert-before]');
    let nodes = $$('[data-block]'), i = nodes.findIndex(node => node.dataset.block === 'image'); assert.equal(nodes[i - 1].querySelector('textarea').value, ''); const beforeId = nodes[i - 1].dataset.block;
    await new Promise(resolve => window.requestAnimationFrame(resolve)); assert.ok(window.document.activeElement.closest(`[data-block="${beforeId}"]`));
    click('[data-block="image"] [data-block-handle]'); click('[data-action=doc-insert-after]'); nodes = $$('[data-block]'); i = nodes.findIndex(node => node.dataset.block === 'image'); assert.equal(nodes[i + 1].querySelector('textarea').value, ''); const afterId = nodes[i + 1].dataset.block;
    // A text caret anchors insertion before/after the whole current paragraph.
    rich('plain').commands.focus('end', { scrollIntoView: false });
    $('[data-action=doc-insert-after]').dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })); click('[data-action=doc-insert-after]'); nodes = $$('[data-block]'); assert.equal(nodes[1].querySelector('textarea').value, ''); const caretId = nodes[1].dataset.block;
    assert.equal(block('plain').querySelector('textarea').value, '普通文本');
    // Typing deletion inside text remains an ordinary edit, never a block delete.
    click('[data-block="plain"] [data-block-handle]'); const content = rich('plain'); content.commands.focus('end', { scrollIntoView: false }); await new Promise(resolve => window.requestAnimationFrame(resolve)); assert.equal(key(content.view.dom, 'Backspace').defaultPrevented, false); assert.ok(block('plain')); content.commands.deleteRange({ from: 4, to: 5 }); assert.equal(block('plain').querySelector('textarea').value, '普通文');
    for (const [index, id] of [...blocks.map(item => item.id), beforeId, afterId, caretId].entries()) {
      click(`[data-block="${id}"] [data-block-handle]`); assert.ok(block(id).classList.contains('is-selected'), `${id} 选中`);
      const event = key(window.document.activeElement, index % 2 ? 'Delete' : 'Backspace'); assert.equal(event.defaultPrevented, true); assert.equal(block(id), null, `${id} 删除`);
    }
    assert.equal($$('[data-block]').length, 1); assert.equal($('[data-block-field=text]').value, '', '删除最后一块仍可继续输入');
    click('[data-action=close-editor]'); await until(() => !$('.editor-overlay'), '保存并关闭'); assert.equal(app.store.project(project.id).draft.blocks.length, 1);
    assert.deepEqual(errors, []); assert.deepEqual($$('.toast.error').map(node => node.textContent), []);
    await window.happyDOM.abort();
  });

  await t.test('跨块精确选择、加选连选、两级全选、批量缩进、无缝图片及空块删除', async () => {
    const image = (await ok('/api/state')).media.find(asset => asset.mime.startsWith('image/'));
    const project = await ok('/api/projects', 'POST', { title: '跨块选择检查', labels: [], blocks: [
      { id: 'a', type: 'text', text: '**ABCDE**' }, { id: 'b', type: 'text', text: '中间段落' },
      { id: 'image', type: 'image', assetId: image.id, alt: '' }, { id: 'image2', type: 'image', assetId: image.id, alt: '' },
      { id: 'e', type: 'text', text: '**VWXYZ**' }, { id: 'empty', type: 'text', text: '' },
    ] }, 201);
    const window = new Window({ url: base, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } }), errors = [];
    Object.defineProperty(window.navigator, 'platform', { value: 'Win32' });
    t.after(async () => { window.PortfolioRichText?.destroyAll(); await window.happyDOM.abort(); });
    window.fetch = (url, options = {}) => fetch(new URL(url, base), { ...options, headers: { ...options.headers, Cookie: cookie } }); window.addEventListener('error', event => errors.push(event.message));
    window.document.write(await readFile(path.join(root, 'public/index.html'), 'utf8'));
    const css = window.document.createElement('style'); css.textContent = await readFile(path.join(root, 'public/style.css'), 'utf8'); window.document.head.append(css);
    window.eval(await readFile(path.join(root, 'public/rich-text.bundle.js'), 'utf8'));
    window.eval((await Promise.all(['media-browser.js', 'editor.js','document-selection.js','document.js','app.js'].map(file => readFile(path.join(root, 'public', file), 'utf8')))).join('\n'));
    const $ = selector => window.document.querySelector(selector), $$ = selector => [...window.document.querySelectorAll(selector)], block = id => $(`[data-block="${id}"]`), rich = id => window.PortfolioRichText.get(id);
    const click = selector => { assert.ok($(selector), selector); $(selector).click(); };
    const key = (node, value, modifiers = {}) => { const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...modifiers }); node.dispatchEvent(event); return event; };
    const pointer = (node, type, x, y, modifiers = {}) => node.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 71, pointerType: 'mouse', button: 0, clientX: x, clientY: y, ...modifiers }));
    const tick = () => new Promise(resolve => window.requestAnimationFrame(resolve));
    const locate = () => $$('[data-block]').forEach((node, i) => { node.getBoundingClientRect = () => ({ top: i * 100, bottom: i * 100 + 90, left: 0, right: 500, width: 500, height: 90 }); const instance = rich(node.dataset.block); if (instance) instance.view.posAtCoords = ({ left }) => ({ pos: left, inside: 0 }); });
    const copySelection = () => { const values = new Map(), event = new window.Event('copy', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'clipboardData', { value: { setData: (kind, value) => values.set(kind, value) } }); window.document.activeElement.dispatchEvent(event); return values.get('text/plain'); };
    await until(() => $('.works-table'), '列表'); click(`[data-action=edit][data-id="${project.id}"]`); await until(() => block('a'), '选择编辑器'); locate();
    assert.equal(parseFloat(window.getComputedStyle($('#block-list')).gap), 0);
    assert.equal(parseFloat(window.getComputedStyle(block('image')).marginBottom), 0); assert.equal(parseFloat(window.getComputedStyle(block('image2')).marginTop), 0);
    // Clicking a gap between existing blocks never adds an accidental paragraph.
    $('#block-list').dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientY: 95 })); assert.equal($$('[data-block]').length, 6);
    rich('a').commands.focus('start', { scrollIntoView: false }); await tick();
    pointer(rich('a').view.dom, 'pointerdown', 3, 20); pointer(rich('a').view.dom, 'pointerup', 3, 20);
    pointer(rich('e').view.dom, 'pointerdown', 3, 420, { ctrlKey: true }); pointer(rich('e').view.dom, 'pointerup', 3, 420); await tick();
    assert.equal($$('.content-block.is-selected').length, 2); assert.equal(block('b').dataset.selected, 'false'); assert.equal(block('image').dataset.selected, 'false');
    key(rich('a').view.dom, 'Tab'); assert.equal(block('a').dataset.indent, '1'); assert.equal(block('e').dataset.indent, '1'); assert.equal(block('b').dataset.indent, '0');
    key(window.document.activeElement, 'Tab', { shiftKey: true }); locate();
    pointer(rich('a').view.dom, 'pointerdown', 3, 20); pointer(rich('e').view.dom, 'pointermove', 3, 420); pointer(rich('e').view.dom, 'pointerup', 3, 420); await tick();
    assert.equal(block('a').querySelector('.document-text-selection').textContent, 'CDE'); assert.equal(block('e').querySelector('.document-text-selection').textContent, 'VW');
    key(window.document.activeElement, 'Escape');
    rich('a').commands.focus('start', { scrollIntoView: false }); rich('a').commands.setTextSelection(3); await tick();
    pointer(rich('e').view.dom, 'pointerdown', 3, 420, { shiftKey: true }); pointer(rich('e').view.dom, 'pointerup', 3, 420); await tick();
    assert.equal(block('a').querySelector('.document-text-selection').textContent, 'CDE'); assert.equal(block('e').querySelector('.document-text-selection').textContent, 'VW');
    assert.ok(block('image').classList.contains('is-selected')); const copied = copySelection(); assert.ok(copied.startsWith('CDE\n\n中间段落')); assert.ok(copied.endsWith('VW'));
    key(rich('a').view.dom, 'Delete'); assert.equal($$('[data-block]').length, 2); assert.equal(rich('a').view.dom.textContent, 'ABXYZ'); assert.ok(rich('a').view.dom.querySelector('strong'), '边界文字保留加粗'); assert.equal(rich('a').state.selection.from, 3);
    // Conversion operates on the current block, preserving the original text.
    click('[data-block="a"] [data-block-handle]'); click('#block-type-menu [data-format=task]'); assert.equal(rich('a').view.dom.querySelector('li p').textContent, 'ABXYZ'); assert.ok(rich('a').view.dom.querySelector('input[type=checkbox]'));
    click('[data-block="a"] [data-block-handle]'); click('#block-type-menu [data-format=h2]'); assert.equal(rich('a').view.dom.querySelector('h2').textContent, 'ABXYZ');
    click('[data-block="a"] [data-block-handle]'); click('#block-type-menu [data-type=table]'); assert.equal(rich('a').view.dom.querySelector('td').textContent, 'ABXYZ'); assert.equal(rich('a').view.dom.querySelectorAll('tr').length, 3);
    click('[data-block="a"] [data-block-handle]'); click('#block-type-menu [data-format=text]'); assert.ok(rich('a').view.dom.textContent.includes('ABXYZ'));
    // One Ctrl+A selects the current text block; the second selects every block.
    rich('a').commands.focus('start', { scrollIntoView: false }); await tick(); key(rich('a').view.dom, 'a', { ctrlKey: true }); assert.equal(rich('a').state.selection.to, window.PortfolioRichText.bounds('a').to); assert.equal($$('.content-block.is-selected').length, 0);
    key(rich('a').view.dom, 'a', { ctrlKey: true }); assert.equal($$('.content-block.is-selected').length, 2);
    key(rich('a').view.dom, 'Tab'); assert.ok($$('[data-block]').every(node => node.dataset.indent === '1'));
    key(window.document.activeElement, 'Tab', { shiftKey: true }); assert.ok($$('[data-block]').every(node => node.dataset.indent === '0'));
    // Non-contiguous Ctrl selection preserves the original clicked block.
    rich('a').commands.focus('start', { scrollIntoView: false }); await tick(); locate();
    pointer(rich('a').view.dom, 'pointerdown', 1, 20); pointer(rich('a').view.dom, 'pointerup', 1, 20);
    pointer(rich('empty').view.dom, 'pointerdown', 1, 120, { ctrlKey: true }); pointer(rich('empty').view.dom, 'pointerup', 1, 120); await tick();
    assert.equal($$('.content-block.is-selected').length, 2); key(window.document.activeElement, 'Delete'); await tick(); assert.equal($$('[data-block]').length, 1); assert.equal($('.rich-editor').textContent, '');
    // Add consecutive media, then delete the empty block immediately below.
    const emptyId = $('[data-block]').dataset.block;
    click(`[data-block="${emptyId}"] [data-block-handle]`); click('#block-type-menu [data-type=image]'); click(`[data-pick="${image.id}"]`); click('[data-action=use-media]');
    let nodes = $$('[data-block]'), imageId = nodes[0].dataset.block, tailId = nodes.at(-1).dataset.block; assert.ok(nodes[0].querySelector('img'));
    rich(tailId).commands.focus('start', { scrollIntoView: false }); await tick(); key(rich(tailId).view.dom, 'Delete'); assert.equal(block(tailId), null); assert.ok(block(imageId).classList.contains('is-selected')); assert.equal(window.document.activeElement, block(imageId));
    // Whole-block Shift selection and mouse dragging both include intervening media.
    click('[data-action=doc-append]'); const nextId = $$('[data-block]').at(-1).dataset.block; rich(nextId).commands.insertContent('结尾');
    click(`[data-block="${imageId}"] [data-block-handle]`); locate(); pointer(block(nextId).querySelector('[data-block-handle]'), 'pointerdown', 1, 120, { shiftKey: true }); pointer(block(nextId), 'pointerup', 1, 120); await tick();
    assert.ok($$('[data-block]').every(node => node.dataset.selected === 'true')); key(window.document.activeElement, 'Tab'); assert.ok($$('[data-block]').every(node => node.dataset.indent === '1'));
    // Reverse drag starts at text, crosses the media, and ends above it.
    locate(); pointer(rich(nextId).view.dom, 'pointerdown', 2, 120); pointer(block(imageId), 'pointermove', 1, 20); pointer(block(imageId), 'pointerup', 1, 20); await tick(); assert.equal($$('.has-document-selection').length, 2);
    key(window.document.activeElement, 'Escape'); rich(nextId).commands.focus('start', { scrollIntoView: false }); await tick(); key(rich(nextId).view.dom, 'Tab');
    click('[data-action=save]'); await until(() => app.store.project(project.id).draft.blocks.find(item => item.id === imageId)?.indent === 1, '媒体缩进持久化');
    const preview = await job(await ok('/api/preview', 'POST', {}, 202));
    const html = (await ok(`${preview.url}data/projects/${project.id}.json`)).html; assert.ok(html.includes('portfolio-indent')); assert.ok(!html.includes('&lt;!-- portfolio-indent'));
    assert.deepEqual(errors, []); assert.deepEqual($$('.toast.error').map(node => node.textContent), []);
  });

  await t.test('多选块成组拖动，连续和非连续选择保持顺序，取消恢复，保存重开一致', async () => {
    const image = (await ok('/api/state')).media.find(asset => asset.mime.startsWith('image/'));
    const project = await ok('/api/projects', 'POST', { title: '成组拖动检查', labels: [], blocks: [
      { id: 'a', type: 'text', text: '**A文字**' }, { id: 'b', type: 'image', assetId: image.id, alt: 'B图片' }, { id: 'c', type: 'text', text: 'C文字' },
      { id: 'd', type: 'table', text: '<!-- portfolio-table row=0 column=0 -->\n| 表格D |  |\n| --- | --- |\n|  |  |' }, { id: 'e', type: 'text', text: 'E文字' }, { id: 'f', type: 'image', assetId: image.id, alt: 'F图片' }, { id: 'g', type: 'text', text: 'G文字' },
    ] }, 201);
    const window = new Window({ url: base, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } }), errors = [];
    Object.defineProperty(window.navigator, 'platform', { value: 'Win32' }); t.after(async () => { window.PortfolioRichText?.destroyAll(); await window.happyDOM.abort(); });
    window.fetch = (url, options = {}) => fetch(new URL(url, base), { ...options, headers: { ...options.headers, Cookie: cookie } }); window.addEventListener('error', event => errors.push(event.message)); window.document.write(await readFile(path.join(root, 'public/index.html'), 'utf8'));
    window.eval(await readFile(path.join(root, 'public/rich-text.bundle.js'), 'utf8')); window.eval((await Promise.all(['media-browser.js', 'editor.js','document-selection.js','document.js','app.js'].map(file => readFile(path.join(root, 'public', file), 'utf8')))).join('\n'));
    const $ = selector => window.document.querySelector(selector), $$ = selector => [...window.document.querySelectorAll(selector)], node = id => $(`[data-block="${id}"]`), grip = id => node(id).querySelector('[data-block-handle]'), order = () => $$('[data-block]').map(item => item.dataset.block);
    const frame = () => new Promise(resolve => window.requestAnimationFrame(resolve)), click = selector => { assert.ok($(selector), selector); $(selector).click(); };
    const pointer = (target, type, x, y, modifiers = {}) => target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 62, pointerType: 'mouse', button: 0, clientX: x, clientY: y, ...modifiers }));
    const prepare = () => { $('.editor-scroll').getBoundingClientRect = () => ({ top: 0, bottom: 1200, height: 1200 }); $$('[data-block]').forEach(item => { item.getBoundingClientRect = () => { const index = order().indexOf(item.dataset.block); return { top: 100 + index * 100, bottom: 195 + index * 100, height: 95, left: 100, right: 500, width: 400 }; }; }); };
    const select = async ids => { await delay(370); grip(ids[0]).click(); for (const id of ids.slice(1)) { pointer(node(id), 'pointerdown', 110, 200, { ctrlKey: true }); pointer(node(id), 'pointerup', 110, 200); } await frame(); assert.deepEqual($$('.is-selected[data-block]').map(item => item.dataset.block), order().filter(id => ids.includes(id))); };
    const drag = async (id, targetId, after = true, cancel = false) => {
      prepare(); const handle = grip(id), start = node(id).getBoundingClientRect(), end = node(targetId).getBoundingClientRect(), y = after ? end.bottom - 3 : end.top + 3;
      pointer(handle, 'pointerdown', 80, start.top + 18); pointer(handle, 'pointermove', 80, y);
      if (cancel) window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); else pointer(handle, 'pointerup', 80, y);
      await frame();
    };
    await until(() => $('.works-table'), '列表'); click(`[data-action=edit][data-id="${project.id}"]`); await until(() => node('d'), '混合块编辑器');
    // The handle of an already-selected image must not collapse the selection.
    await select(['b','c','d']); await drag('b', 'f'); assert.deepEqual(order(), ['a','e','f','b','c','d','g']); assert.deepEqual($$('.is-selected[data-block]').map(item => item.dataset.block), ['b','c','d']); assert.ok(window.document.activeElement.matches('[data-block-handle]'));
    await select(['b','c','d']); await drag('d', 'a', false); assert.deepEqual(order(), ['b','c','d','a','e','f','g']);
    // Ctrl selections may be made in any order; the document order is retained.
    await select(['f','a']); await drag('f', 'b', false); assert.deepEqual(order(), ['a','f','b','c','d','e','g']); assert.deepEqual($$('.is-selected[data-block]').map(item => item.dataset.block), ['a','f']);
    const beforeCancel = order(); await drag('a', 'g', true, true); assert.deepEqual(order(), beforeCancel); assert.deepEqual($$('.is-selected[data-block]').map(item => item.dataset.block), ['a','f']); assert.equal($('#block-drag-preview'), null); assert.equal($$('.sorting-source').length, 0);
    // Dragging an unselected handle moves only that block.
    await drag('e', 'a', false); assert.deepEqual(order(), ['e','a','f','b','c','d','g']); assert.deepEqual($$('.is-selected[data-block]').map(item => item.dataset.block), ['e']);
    // Native HTML dragging uses the same group operation.
    await select(['b','d']); prepare(); const transfer = { effectAllowed: '', setData() {} }, handle = grip('d'), target = node('g'), rect = target.getBoundingClientRect();
    const native = (element, type) => { const event = new window.Event(type, { bubbles: true, cancelable: true }); Object.defineProperties(event, { dataTransfer: { value: transfer }, clientX: { value: 80 }, clientY: { value: rect.bottom - 3 } }); element.dispatchEvent(event); };
    native(handle, 'dragstart'); native(target, 'dragover'); native(target, 'drop'); native(handle, 'dragend'); await frame(); assert.deepEqual(order(), ['e','a','f','c','g','b','d']);
    // Selecting all offers no external drop target and leaves the order intact.
    await select(order()); const beforeAll = order(); await drag('f', 'g'); assert.deepEqual(order(), beforeAll);
    const expected = order(); click('[data-action=save]'); await until(() => app.store.project(project.id).draft.blocks.map(item => item.id).join() === expected.join(), '组排序保存');
    click('[data-action=close-editor]'); await until(() => !$('.editor-overlay'), '关闭'); click(`[data-action=edit][data-id="${project.id}"]`); assert.deepEqual(order(), expected); assert.ok(window.PortfolioRichText.get('a').view.dom.querySelector('strong')); assert.ok(node('d').querySelector('table').textContent.includes('表格D')); assert.equal(node('b').querySelector('img').alt, 'B图片');
    assert.deepEqual(errors, []); assert.deepEqual($$('.toast.error').map(item => item.textContent), []);
  });

  await t.test('已选中当前块时CtrlA直接全选，手柄不随全选常显，块选中使用范围内覆盖层', async () => {
    const image = (await ok('/api/state')).media.find(asset => asset.mime.startsWith('image/'));
    const project = await ok('/api/projects', 'POST', { title: '全选与选中外观检查', labels: [], blocks: [{ id: 'a', type: 'text', text: '**ABCDE**' }, { id: 'b', type: 'text', text: '另一段文字' }, { id: 'media', type: 'image', assetId: image.id, alt: '' }, { id: 'empty', type: 'text', text: '' }] }, 201);
    const window = new Window({ url: base, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } }), errors = [];
    Object.defineProperty(window.navigator, 'platform', { value: 'Win32' }); t.after(async () => { window.PortfolioRichText?.destroyAll(); await window.happyDOM.abort(); });
    window.fetch = (url, options = {}) => fetch(new URL(url, base), { ...options, headers: { ...options.headers, Cookie: cookie } }); window.addEventListener('error', event => errors.push(event.message));
    window.document.write(await readFile(path.join(root, 'public/index.html'), 'utf8'));
    const css = window.document.createElement('style'); css.textContent = await readFile(path.join(root, 'public/style.css'), 'utf8'); window.document.head.append(css);
    window.eval(await readFile(path.join(root, 'public/rich-text.bundle.js'), 'utf8')); window.eval((await Promise.all(['media-browser.js', 'editor.js','document-selection.js','document.js','app.js'].map(file => readFile(path.join(root, 'public', file), 'utf8')))).join('\n'));
    const $ = selector => window.document.querySelector(selector), $$ = selector => [...window.document.querySelectorAll(selector)], rich = id => window.PortfolioRichText.get(id);
    const click = selector => { assert.ok($(selector), selector); $(selector).click(); };
    const key = node => { const event = new window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }); node.dispatchEvent(event); assert.equal(event.defaultPrevented, true); };
    const reset = id => { const node = $(`[data-block="${id}"]`); node.dispatchEvent(new window.PointerEvent('pointerdown', { pointerId: 23, pointerType: 'mouse', button: 0, bubbles: true })); node.dispatchEvent(new window.PointerEvent('pointerup', { pointerId: 23, pointerType: 'mouse', button: 0, bubbles: true })); };
    const frame = () => new Promise(resolve => window.requestAnimationFrame(resolve));
    await until(() => $('.works-table'), '列表'); click(`[data-action=edit][data-id="${project.id}"]`); await until(() => rich('a'), '编辑器');
    // A whole block selected through its handle is already the first level.
    click('[data-block="a"] [data-block-handle]'); assert.equal($$('.content-block.is-selected').length, 1); key($('#block-type-menu button')); assert.equal($$('.content-block.is-selected').length, 4);
    assert.equal($$('.document-text-selection').length, 0, '整块覆盖时不再重复叠加文字选区');
    for (const block of $$('[data-block]')) { assert.equal(window.getComputedStyle(block).outlineStyle, 'none'); assert.equal(window.getComputedStyle(block.querySelector('[data-block-handle]')).opacity, '0', '全选不显示全部手柄'); }
    // A selection made directly with the text editor also promotes to all.
    reset('a'); rich('a').commands.focus('start', { scrollIntoView: false }); await frame(); rich('a').commands.setTextSelection({ from: 1, to: 6 }); key(rich('a').view.dom); assert.equal($$('.content-block.is-selected').length, 4);
    // Partial text remains the first level. An empty paragraph skips that
    // level and selects the entire document on its first Ctrl+A.
    reset('a'); rich('a').commands.focus('start', { scrollIntoView: false }); await frame(); rich('a').commands.setTextSelection({ from: 2, to: 3 }); key(rich('a').view.dom); assert.equal($$('.content-block.is-selected').length, 0); assert.equal(rich('a').state.selection.from, 1); assert.equal(rich('a').state.selection.to, 6); key(rich('a').view.dom); assert.equal($$('.content-block.is-selected').length, 4);
    reset('empty'); rich('empty').commands.focus('start', { scrollIntoView: false }); await frame(); key(rich('empty').view.dom); assert.equal($$('.content-block.is-selected').length, 4);
    reset('media'); click('[data-block="media"]'); $('[data-block="media"]').focus({ preventScroll: true }); key($('[data-block="media"]')); assert.equal($$('.content-block.is-selected').length, 4);
    const overlay = [...css.sheet.cssRules].find(rule => rule.selectorText === '.editor-shell .document-body .content-block.is-selected:after');
    assert.ok(overlay); assert.equal(overlay.style.inset, '0'); assert.equal(overlay.style.pointerEvents, 'none'); assert.equal(overlay.style.zIndex, '1'); assert.ok(overlay.style.background.includes('8cbcf44a') || overlay.style.background.includes('rgba'), '浅蓝透明覆盖层在媒体上方');
    assert.deepEqual(errors, []); assert.deepEqual($$('.toast.error').map(node => node.textContent), []);
  });

  await t.test('末尾新增与转换块在完整挂载后恢复滚动，仅对屏幕外光标作最小滚动', async () => {
    const image = (await ok('/api/state')).media.find(asset => asset.mime.startsWith('image/'));
    const project = await ok('/api/projects', 'POST', { title: '末尾滚动稳定检查', labels: [], blocks: [{ id: 'image', type: 'image', assetId: image.id, alt: '' }, ...Array.from({ length: 24 }, (_, i) => ({ id: `line-${i}`, type: 'text', text: `第${i + 1}段：连续编辑时保持当前阅读位置。` }))] }, 201);
    const window = new Window({ url: base, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } }), errors = [], offsets = new WeakMap(), writes = [];
    Object.defineProperty(window.navigator, 'platform', { value: 'Win32' });
    // Model the browser's scroll clamping while newly created rich hosts are
    // still empty. happy-dom itself does not implement layout or clamping.
    Object.defineProperty(window.HTMLElement.prototype, 'scrollTop', { configurable: true,
      get() { return offsets.get(this) || 0; },
      set(value) {
        if (!this.classList.contains('editor-scroll')) { offsets.set(this, value); return; }
        const hosts = [...this.querySelectorAll('.rich-block-host')], mounted = hosts.length > 0 && hosts.every(host => host.querySelector('.rich-editor'));
        const actual = Math.max(0, Math.min(value, mounted ? 5000 : 300)); writes.push({ value, actual, mounted }); offsets.set(this, actual);
      },
    });
    const nativeRect = window.HTMLElement.prototype.getBoundingClientRect;
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList.contains('editor-scroll')) return { top: 0, bottom: 650, left: 0, right: 900, width: 900, height: 650 };
      if (this.classList.contains('document-toolbar')) return { top: 90, bottom: 140, left: 0, right: 600, width: 600, height: 50 };
      return nativeRect.call(this);
    };
    t.after(async () => { window.PortfolioRichText?.destroyAll(); await window.happyDOM.abort(); });
    window.fetch = (url, options = {}) => fetch(new URL(url, base), { ...options, headers: { ...options.headers, Cookie: cookie } }); window.addEventListener('error', event => errors.push(event.message));
    window.document.write(await readFile(path.join(root, 'public/index.html'), 'utf8')); window.eval(await readFile(path.join(root, 'public/rich-text.bundle.js'), 'utf8'));
    window.eval((await Promise.all(['media-browser.js', 'editor.js','document-selection.js','document.js','app.js'].map(file => readFile(path.join(root, 'public', file), 'utf8')))).join('\n'));
    const $ = selector => window.document.querySelector(selector), $$ = selector => [...window.document.querySelectorAll(selector)], rich = id => window.PortfolioRichText.get(id);
    const click = selector => { assert.ok($(selector), selector); $(selector).click(); };
    const key = (node, value) => { const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }); node.dispatchEvent(event); return event; };
    const frame = () => new Promise(resolve => window.requestAnimationFrame(resolve));
    const caret = (id, top = 500) => { rich(id).view.coordsAtPos = () => ({ top, bottom: top + 28, left: 100, right: 101 }); };
    await until(() => $('.works-table'), '作品列表'); click(`[data-action=edit][data-id="${project.id}"]`); await until(() => rich('line-23'), '长文档挂载');
    const displayed = $('[data-block="image"]>img'); assert.equal(displayed.getAttribute('width'), String(image.width)); assert.equal(displayed.getAttribute('height'), String(image.height));
    $('.editor-scroll').scrollTop = 1600; rich('line-23').commands.focus('end', { scrollIntoView: false }); await frame(); writes.length = 0;
    key(rich('line-23').view.dom, 'Enter'); let id = $$('[data-block]').at(-1).dataset.block; caret(id); await frame(); await frame();
    assert.equal($('.editor-scroll').scrollTop, 1600); assert.ok(writes.every(write => write.mounted || write.value === 0), '恢复偏移时所有富文本块均已挂载');
    click(`[data-block="${id}"] [data-block-handle]`); assert.equal($('.editor-scroll').scrollTop, 1600, '打开末尾菜单不滚动');
    click('#block-type-menu [data-format=h2]'); caret(id); await frame(); await frame(); assert.ok(rich(id).view.dom.querySelector('h2')); assert.equal($('.editor-scroll').scrollTop, 1600);
    click(`[data-block="${id}"] [data-block-handle]`); click('#block-type-menu [data-format=code]'); caret(id); await frame(); await frame(); assert.ok(rich(id).view.dom.querySelector('pre')); assert.equal($('.editor-scroll').scrollTop, 1600);
    click(`[data-block="${id}"] [data-block-handle]`); click('#block-type-menu [data-format=text]'); caret(id); await frame(); await frame();
    key(rich(id).view.dom, '/'); assert.ok($('#block-type-menu')); assert.equal($('.editor-scroll').scrollTop, 1600); key($('#block-type-menu button'), 'Escape'); caret(id); await frame(); await frame(); assert.equal($('.editor-scroll').scrollTop, 1600);
    // A new caret just below the viewport moves down only the missing 28px.
    key(rich(id).view.dom, 'Enter'); id = $$('[data-block]').at(-1).dataset.block; caret(id, 630); await frame(); await frame(); assert.equal($('.editor-scroll').scrollTop, 1628);
    assert.deepEqual(errors, []); assert.deepEqual($$('.toast.error').map(node => node.textContent), []);
  });

  await t.test('手动保存反馈位于按钮，快捷键共用状态，重复保存及界面刷新不丢失反馈', async () => {
    const project = await ok('/api/projects', 'POST', { title: '保存按钮反馈检查', labels: [], blocks: [{ id: 'text', type: 'text', text: '正文' }] }, 201);
    const window = new Window({ url: base, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } }), errors = [];
    t.after(() => window.happyDOM.abort()); let gate = null, failNext = false, saves = 0;
    window.fetch = async (url, options = {}) => {
      if (new URL(url, base).pathname === `/api/projects/${project.id}` && options.method === 'PUT') {
        saves++; const wait = gate; gate = null; if (wait) await wait;
        if (failNext) { failNext = false; return new Response(JSON.stringify({ error: '测试保存失败，可重试' }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
      }
      return fetch(new URL(url, base), { ...options, headers: { ...options.headers, Cookie: cookie } });
    };
    window.addEventListener('error', event => errors.push(event.message)); window.document.write(await readFile(path.join(root, 'public/index.html'), 'utf8'));
    window.eval((await Promise.all(['media-browser.js', 'editor.js','document-selection.js','document.js','app.js'].map(file => readFile(path.join(root, 'public', file), 'utf8')))).join('\n'));
    const $ = selector => window.document.querySelector(selector), button = () => $('.editor-heading [data-action=save]');
    const click = selector => { assert.ok($(selector), selector); $(selector).click(); }, input = (selector, value) => { $(selector).value = value; $(selector).dispatchEvent(new window.Event('input', { bubbles: true })); };
    const shortcut = (modifiers = { ctrlKey: true }) => { const event = new window.KeyboardEvent('keydown', { key: 's', ...modifiers, bubbles: true, cancelable: true }); $('[data-field=title]').dispatchEvent(event); assert.equal(event.defaultPrevented, true); };
    await until(() => $('.works-table'), '列表'); click(`[data-action=edit][data-id="${project.id}"]`);
    assert.equal(button().textContent, '保存草稿'); assert.equal(button().dataset.saveFeedback, 'ready');
    input('[data-field=title]', '点击按钮保存的草稿'); let release; gate = new Promise(resolve => { release = resolve; }); click('[data-action=save]');
    assert.equal(button().dataset.saveFeedback, 'saving'); assert.equal(button().textContent, '保存中…'); assert.equal(button().disabled, true); assert.equal(button().getAttribute('aria-busy'), 'true');
    shortcut(); assert.equal(saves, 1, '保存中按快捷键不重复发送请求');
    click('[data-device=mobile]'); assert.equal(button().dataset.saveFeedback, 'saving', '编辑器重新渲染保留反馈');
    release(); await until(() => button().dataset.saveFeedback === 'saved', '按钮已保存'); assert.equal(button().textContent, '已保存'); assert.equal(button().disabled, false); assert.equal(app.store.project(project.id).draft.title, '点击按钮保存的草稿');
    assert.equal([...window.document.querySelectorAll('.toast')].some(node => node.textContent === '草稿已保存'), false);
    click('[data-device=desktop]'); assert.equal(button().dataset.saveFeedback, 'saved');
    await until(() => button().dataset.saveFeedback === 'ready', '按钮稍后恢复'); assert.equal(button().textContent, '保存草稿');
    shortcut({ metaKey: true }); await until(() => button().dataset.saveFeedback === 'saved', '无修改时CmdS反馈'); assert.equal(saves, 1, '未修改时无需重复写入');
    input('[data-field=description]', '快捷键保存失败后重试'); assert.equal(button().dataset.saveFeedback, 'ready'); failNext = true; shortcut();
    await until(() => button().dataset.saveFeedback === 'error', '失败可见'); assert.equal(button().textContent, '保存失败'); assert.equal(button().disabled, false); assert.ok($('.toast.error').textContent.includes('测试保存失败'));
    click('[data-action=save]'); await until(() => button().dataset.saveFeedback === 'saved', '重试保存成功'); assert.equal(app.store.project(project.id).draft.description, '快捷键保存失败后重试');
    input('[data-field=description]', '保存中仍可继续编辑'); gate = new Promise(resolve => { release = resolve; }); shortcut(); input('[data-field=description]', '本次请求之后的新修改'); release();
    await until(() => button().dataset.saveFeedback === 'pending', '新修改不会误显示全部已保存'); assert.equal(button().textContent, '有新修改');
    click('[data-action=close-editor]'); await until(() => !$('.editor-overlay'), '关闭并保存'); click(`[data-action=edit][data-id="${project.id}"]`); assert.equal(button().dataset.saveFeedback, 'ready'); assert.equal($('[data-field=description]').value, '本次请求之后的新修改');
    assert.equal([...window.document.querySelectorAll('.toast')].some(node => node.textContent === '草稿已保存'), false); assert.deepEqual(errors, []);
  });

  await t.test('点击封面裁切、下方选择封面与首图开关，切换来源保持比例', async () => {
    const assets = (await ok('/api/state')).media, first = assets.find(asset => asset.width === 6 && asset.height === 4), second = assets.find(asset => asset.mime.startsWith('image/') && asset.id !== first.id);
    const projects = [];
    for (const ratio of ['3:4', 'auto']) projects.push(await ok('/api/projects', 'POST', { title: `封面比例保持-${ratio}`, labels: [], useFirstImage: false, coverAssetId: second.id, coverRatio: ratio, coverCrop: { x: .3, y: .7, zoom: 1.4 }, blocks: [{ id: 'body', type: 'image', assetId: first.id, alt: '' }] }, 201));
    const window = new Window({ url: base, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } }), errors = [];
    t.after(() => window.happyDOM.abort()); window.fetch = (url, options = {}) => fetch(new URL(url, base), { ...options, headers: { ...options.headers, Cookie: cookie } });
    window.addEventListener('error', event => errors.push(event.message)); window.document.write(await readFile(path.join(root, 'public/index.html'), 'utf8'));
    const css = window.document.createElement('style'); css.textContent = await readFile(path.join(root, 'public/style.css'), 'utf8'); window.document.head.append(css);
    window.eval((await Promise.all(['media-browser.js', 'editor.js','document-selection.js','document.js','app.js'].map(file => readFile(path.join(root, 'public', file), 'utf8')))).join('\n'));
    const $ = selector => window.document.querySelector(selector), click = selector => { assert.ok($(selector), selector); $(selector).click(); };
    await until(() => $('.works-table'), '作品列表');
    for (const project of projects) {
      click(`[data-action=edit][data-id="${project.id}"]`); await until(() => $('.cover-picker'), '封面编辑器');
      const ratio = $('.cover-ratio-label').textContent.trim();
      assert.equal($('.document-cover .field-label [data-action=edit-crop]'), null);
      assert.equal($('.cover-options [data-action=choose-cover]').nextElementSibling, $('[data-action=toggle-first-cover]'));
      assert.equal($('.cover-picker').dataset.action, 'edit-crop'); assert.equal($('.cover-options [data-action=choose-cover]').textContent, '选择封面');
      assert.equal(window.getComputedStyle($('.document-cover .cover-options')).flexDirection, 'row');
      assert.ok($('.cover-picker img').src.includes(second.id));
      click('[data-action=toggle-first-cover]'); assert.ok($('.cover-picker img').src.includes(first.id)); assert.equal($('.cover-ratio-label').textContent.trim(), ratio);
      click('[data-action=choose-cover]'); assert.ok($('#dialog h2').textContent.includes('上传或选择媒体')); assert.equal($('.crop-stage'), null);
      click(`[data-pick="${second.id}"]`); click('[data-action=use-media]'); assert.ok($('.crop-stage')); assert.ok($('#dialog h2').textContent.includes('封面比例与裁切'));
      assert.equal(window.getComputedStyle($('.crop-reset-row')).justifyContent, 'center');
      assert.equal($('.crop-workspace').nextElementSibling, $('.crop-reset-row')); assert.equal($('.crop-reset-row [data-action=crop-reset]').textContent, '重置');
      click('[data-action=close-dialog]'); assert.equal($('[data-action=toggle-first-cover]').getAttribute('aria-checked'), 'true', '取消选择封面的裁切不改变首图模式');
      click('[data-action=toggle-first-cover]'); assert.ok($('.cover-picker img').src.includes(second.id)); assert.equal($('.cover-ratio-label').textContent.trim(), ratio);
      click('[data-action=save]'); await until(() => app.store.project(project.id).draft.coverRatio === ratio, '保存固定后的显示比例');
      click('[data-action=close-editor]'); await until(() => !$('.editor-overlay'), '关闭比例检查');
      click(`[data-action=edit][data-id="${project.id}"]`); assert.equal($('.cover-ratio-label').textContent.trim(), ratio);
      click('.cover-picker'); assert.equal($('.crop-ratios .active').textContent.trim(), ratio);
      click('[data-action=crop-ratio][data-ratio="1:1"]'); click('[data-action=apply-crop]');
      click('[data-action=toggle-first-cover]'); click('[data-action=toggle-first-cover]'); assert.equal($('.cover-ratio-label').textContent.trim(), '1:1');
      click('[data-action=close-editor]'); await until(() => !$('.editor-overlay'), '保存新裁切比例'); assert.equal(app.store.project(project.id).draft.coverRatio, '1:1');
    }
    assert.deepEqual(errors, []); assert.deepEqual([...window.document.querySelectorAll('.toast.error')].map(node => node.textContent), []);
  });

  await t.test('首图封面独立裁切、滚轮缩放、回车插块、保存快捷键、统一预览与发布保留草稿', async () => {
    const assets = (await ok('/api/state')).media, first = assets.find(asset => asset.width === 6 && asset.height === 4), second = assets.find(asset => asset.mime.startsWith('image/') && asset.id !== first.id);
    let row = await ok('/api/projects', 'POST', { title: '封面和快捷键检查', useFirstImage: true, labels: [], blocks: [
      { id: 'first-image', type: 'image', assetId: first.id, alt: '' }, { id: 'second-image', type: 'image', assetId: second.id, alt: '' },
      ...['video','audio'].map(kind => ({ id: kind, type: kind, assetId: assets.find(asset => asset.mime.startsWith(kind + '/')).id, alt: '' })),
    ] }, 201);
    assert.equal((await request(`/api/projects/${row.id}`, 'PUT', { ...row.draft, revision: row.revision, useFirstImage: 'yes' })).response.status, 400);
    const window = new Window({ url: base, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } }), errors = [];
    Object.defineProperty(window.navigator, 'platform', { value: 'Win32' }); t.after(async () => { window.PortfolioRichText?.destroyAll(); await window.happyDOM.abort(); });
    window.fetch = (url, options = {}) => fetch(new URL(url, base), { ...options, headers: { ...options.headers, Cookie: cookie } }); window.addEventListener('error', event => errors.push(event.message));
    window.document.write(await readFile(path.join(root, 'public/index.html'), 'utf8')); window.eval(await readFile(path.join(root, 'public/rich-text.bundle.js'), 'utf8'));
    window.eval((await Promise.all(['media-browser.js', 'editor.js','document-selection.js','document.js','app.js'].map(file => readFile(path.join(root, 'public', file), 'utf8')))).join('\n'));
    const $ = selector => window.document.querySelector(selector), $$ = selector => [...window.document.querySelectorAll(selector)];
    const click = selector => { assert.ok($(selector), selector); $(selector).click(); }, key = (node, value, modifiers = {}) => { const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...modifiers }); node.dispatchEvent(event); return event; };
    const input = (selector, value) => { $(selector).value = value; $(selector).dispatchEvent(new window.Event('input', { bubbles: true })); };
    const pointer = (node, type, x, y) => node.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 40, pointerType: 'mouse', button: 0, clientX: x, clientY: y }));
    await until(() => $('.works-table'), '作品列表'); click(`[data-action=edit][data-id="${row.id}"]`); await until(() => $('.cover-picker'), '编辑封面');
    assert.equal($('[role=switch]').getAttribute('aria-checked'), 'true'); assert.ok($('.cover-ratio-label').textContent.includes('3:2'), '自然图片比例匹配，不固定1:1');
    assert.equal($$('.editor-shell [data-action=preview-editor]').length, 1); assert.equal($('.editor-heading [data-action=preview-editor]'), null); assert.equal($('.preview-tools [data-action=preview-editor]').textContent, '预览');
    const beforeTitle = $$('[data-block]').length; assert.equal(key($('[data-field=title]'), 'Enter').defaultPrevented, true); assert.equal($$('[data-block]').length, beforeTitle + 1); assert.equal($$('[data-block]')[0].querySelector('textarea').value, ''); assert.equal($$('[data-block]')[1].dataset.block, 'first-image');
    for (const id of ['first-image','video','audio']) { click(`[data-block="${id}"] [data-block-handle]`); assert.equal(key(window.document.activeElement, 'Enter').defaultPrevented, true); const nodes = $$('[data-block]'), index = nodes.findIndex(node => node.dataset.block === id); assert.equal(nodes[index + 1].querySelector('textarea').value, ''); }
    click('.cover-picker'); assert.equal($('#crop-zoom'), null); assert.equal($('.crop-body input[type=range]'), null); assert.ok($('[data-action=crop-reset]'));
    click('[data-action=crop-ratio][data-ratio="3:4"]'); let stage = $('.crop-stage'); stage.getBoundingClientRect = () => ({ left: 20, top: 30, width: 300, height: 400 });
    const wheel = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -Math.log(2) / .0015 }); Object.defineProperties(wheel, { clientX: { value: 170 }, clientY: { value: 230 } }); stage.dispatchEvent(wheel); assert.equal(wheel.defaultPrevented, true); assert.ok($('.crop-stage img').style.transform.includes('scale(2)'));
    pointer(stage, 'pointerdown', 170, 230); pointer(stage, 'pointermove', 260, 270); pointer(stage, 'pointerup', 260, 270); assert.ok(Math.abs(parseFloat($('.crop-stage img').style.objectPosition) - 40) < .0001, $('.crop-stage img').getAttribute('style'));
    click('[data-action=apply-crop]'); assert.equal($('[role=switch]').getAttribute('aria-checked'), 'true'); assert.ok($('.cover-ratio-label').textContent.includes('3:4')); assert.ok($('.cover-picker img').style.transform.includes('scale(2)'));
    click('[data-action=toggle-first-cover]'); assert.equal($('[role=switch]').getAttribute('aria-checked'), 'false'); assert.ok($('[data-action=choose-cover]')); click('[data-action=toggle-first-cover]'); assert.equal($('[role=switch]').getAttribute('aria-checked'), 'true');
    click('.cover-picker'); assert.ok($('[data-action=crop-ratio].active').textContent.includes('3:4')); assert.ok($('.crop-stage img').style.transform.includes('scale(2)')); click('[data-action=crop-reset]'); assert.ok($('.crop-stage img').style.transform.includes('scale(1)')); click('[data-action=close-dialog]');
    input('[data-field=title]', 'CtrlS保存的封面作品'); assert.equal(key($('[data-field=title]'), 's', { ctrlKey: true }).defaultPrevented, true);
    await until(() => app.store.project(row.id).draft.title === 'CtrlS保存的封面作品', 'CtrlS保存'); row = app.store.project(row.id); assert.equal(row.draft.useFirstImage, true); assert.equal(row.draft.coverRatio, '3:4'); assert.equal(row.draft.coverCrop.zoom, 2); assert.ok(Math.abs(row.draft.coverCrop.x - .4) < .0001);
    input('[data-field=description]', 'CmdS也可保存'); assert.equal(key($('[data-field=description]'), 's', { metaKey: true }).defaultPrevented, true); await until(() => app.store.project(row.id).draft.description === 'CmdS也可保存', 'CmdS保存');
    click('[data-action=preview-editor]'); await until(() => $('.preview-viewport iframe'), '首图裁切真实预览'); assert.equal($('.preview-tools [data-action=preview-editor]').textContent, '刷新预览'); assert.equal($$('.editor-shell [data-action=preview-editor]').length, 1);
    const previewURL = $('.preview-viewport iframe').getAttribute('src').split(/[?#]/)[0], cover = (await manifest(previewURL)).find(project => project.id === row.id);
    assert.equal(cover.coverRatio, '3:4'); assert.equal(cover.coverSource, 'body-image'); assert.ok(cover.cover.includes(first.file)); assert.equal(cover.coverCrop.zoom, 2);
    click('[data-action=close-editor]'); await until(() => !$('.editor-overlay'), '关闭作品');
    const draft = app.store.project(row.id).draft; await job(await ok('/api/publish', 'POST', { projectIds: [row.id], includeSettings: false }, 202)); row = app.store.project(row.id); assert.deepEqual(row.draft, draft, '发布保留草稿'); assert.deepEqual(row.live, draft, '发布复制到展示版本');
    const blocks = [...row.draft.blocks], index = blocks.findIndex(block => block.id === 'first-image'); blocks.push(blocks.splice(index, 1)[0]);
    row = await ok(`/api/projects/${row.id}`, 'PUT', { ...row.draft, revision: row.revision, blocks, description: '发布后的新草稿' }); assert.equal(row.live.description, draft.description); assert.equal(row.draft.description, '发布后的新草稿');
    let preview = await job(await ok('/api/preview', 'POST', {}, 202)), item = (await manifest(preview.url)).find(project => project.id === row.id); assert.ok(item.cover.includes(second.file), '首图模式跟随正文排序'); assert.equal(item.coverRatio, '3:4');
    row = await ok(`/api/projects/${row.id}`, 'PUT', { ...row.draft, revision: row.revision, useFirstImage: false, coverAssetId: null, coverCrop: null });
    preview = await job(await ok('/api/preview', 'POST', {}, 202)); item = (await manifest(preview.url)).find(project => project.id === row.id); assert.equal(item.cover, null, '关闭首图开关且无独立封面时不隐式使用首图');
    row = await ok(`/api/projects/${row.id}`, 'PUT', { ...row.draft, revision: row.revision, useFirstImage: true, coverCrop: draft.coverCrop, blocks: [{ id: 'only-text', type: 'text', text: '暂时没有正文图片' }] });
    preview = await job(await ok('/api/preview', 'POST', {}, 202)); item = (await manifest(preview.url)).find(project => project.id === row.id); assert.equal(item.cover, null); assert.equal(item.coverCrop, null, '无首图时保留编辑参数但不输出失效裁切');
    assert.deepEqual(errors, []); assert.deepEqual($$('.toast.error').map(node => node.textContent), []); await window.happyDOM.abort();
  });

  await t.test('已有数据保留，启动迁移清理旧账号和登录会话', async () => {
    assert.ok((await readFile(path.join(dataDir, 'portfolio.sqlite'))).length > 0);
    const before=app.store.projects(),settings=app.store.get('settingsDraft');
    app.store.set('account',{username:'old-admin',salt:'old-salt',hash:'old-hash'});
    app.store.db.exec("CREATE TABLE sessions(token TEXT PRIMARY KEY,expires INTEGER NOT NULL); INSERT INTO sessions VALUES('old-session',9999999999999)");
    const reopened = await openStore(dataDir, path.join(root, 'renderer'));
    assert.deepEqual(reopened.get('settingsDraft'),settings);assert.deepEqual(reopened.projects(),before);
    assert.equal(reopened.get('account'),null);assert.equal(reopened.db.prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get(),undefined);
    reopened.close();
    assert.equal((await ok('/api/state')).settings.tagline, '管理页设置草稿');
  });

  await t.test('允许全部下架，空作品站点仍可构建', async () => {
    const result = await job(app.publisher.start('preview', { settings: app.store.get('settingsLive'), projects: [] }));
    assert.equal((await request(result.url)).response.status, 200);
    const data = await manifest(result.url); assert.equal(Array.isArray(data) ? data.length : data.projects.length, 0);
  });
  console.log(`测试数据与可独立检查的导出包：${dataDir}`);
});
