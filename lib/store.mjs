import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { loadContent } from '../renderer/scripts/content.mjs';
import { coverAssetId } from './cover.mjs';
import { homeBackgroundAssets, defaultHomeBackground } from './home-background.mjs';

export const now = () => new Date().toISOString();
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const parse = value => value ? JSON.parse(value) : null;
export class Store {
  constructor(directory) {
    this.directory = directory;
    this.db = new DatabaseSync(path.join(directory, 'portfolio.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,draft TEXT NOT NULL,live TEXT,revision INTEGER NOT NULL DEFAULT 1,deletedAt TEXT,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,name TEXT NOT NULL,file TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,hash TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS releases(id TEXT PRIMARY KEY,title TEXT NOT NULL,createdAt TEXT NOT NULL,snapshot TEXT NOT NULL);`);
    // Retire old account credentials and sessions without touching portfolio data.
    this.transaction(()=>{this.db.prepare("DELETE FROM meta WHERE key='account'").run();this.db.exec('DROP TABLE IF EXISTS sessions');});
    if (!this.db.prepare('PRAGMA table_info(media)').all().some(column => column.name === 'library')) this.db.exec('ALTER TABLE media ADD COLUMN library INTEGER NOT NULL DEFAULT 1');
    this.db.exec('CREATE TABLE IF NOT EXISTS pending_media(assetId TEXT NOT NULL,projectId TEXT NOT NULL,PRIMARY KEY(assetId,projectId))');
    this.db.exec('CREATE TABLE IF NOT EXISTS media_folders(id TEXT PRIMARY KEY,name TEXT NOT NULL,parentId TEXT REFERENCES media_folders(id),createdAt TEXT NOT NULL,sortOrder REAL NOT NULL)');
    const mediaColumns = this.db.prepare('PRAGMA table_info(media)').all();
    if (!mediaColumns.some(column => column.name === 'folderId')) this.db.exec('ALTER TABLE media ADD COLUMN folderId TEXT REFERENCES media_folders(id)');
    if (!mediaColumns.some(column => column.name === 'sortOrder')) this.db.exec('ALTER TABLE media ADD COLUMN sortOrder REAL NOT NULL DEFAULT 0; UPDATE media SET sortOrder=-rowid');
  }
  get(key) { return parse(this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value); }
  set(key, value) { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  projects() {
    return this.db.prepare('SELECT * FROM projects').all().map(row => ({ ...row, draft: parse(row.draft), live: parse(row.live) })).sort((a, b) => a.draft.order - b.draft.order || a.id.localeCompare(b.id));
  }
  project(id) { return this.projects().find(project => project.id === id); }
  createProject(document) {
    return this.transaction(() => {
      const order = Math.min(0, ...this.projects().filter(row => !row.deletedAt).map(row => row.draft.order)) - 1;
      const draft = { ...document, order };
      this.db.prepare('INSERT INTO projects(id,draft,updatedAt) VALUES(?,?,?)').run(draft.id, JSON.stringify(draft), now());
      return this.project(draft.id);
    });
  }
  media() { return this.db.prepare('SELECT * FROM media ORDER BY createdAt DESC').all().map(asset => ({ ...asset, pendingProjects: this.db.prepare('SELECT projectId FROM pending_media WHERE assetId=?').all(asset.id).map(row => row.projectId) })); }
  asset(id) { return this.db.prepare('SELECT * FROM media WHERE id=?').get(id); }
  releases() { return this.db.prepare('SELECT * FROM releases ORDER BY createdAt DESC').all().map(row => ({ ...row, snapshot: parse(row.snapshot) })); }
  references(assetId) {
    const used = document => document?.coverAssetId === assetId || document?.blocks?.some(block => block.assetId === assetId);
    const projects = this.projects().filter(project => used(project.draft) || used(project.live)).map(project => ({ id: project.id, title: project.draft.title }));
    const inSettings = [this.get('settingsDraft'),this.get('settingsLive')].some(settings=>homeBackgroundAssets(settings).includes(assetId));
    const inHistory = this.releases().some(release => release.snapshot.projects.some(used)||homeBackgroundAssets(release.snapshot.settings).includes(assetId));
    return { projects, inHistory, inSettings };
  }
  async addAsset(bytes, name, mime, dimensions, extension, projectId = null, folderId = null) {
    const hash = digest(bytes), existing = this.db.prepare('SELECT * FROM media WHERE hash=? AND folderId IS ?').get(hash, folderId);
    if (existing) { this.registerAsset(existing.id, projectId); return this.asset(existing.id); }
    const id = randomUUID(), file = `${id}.${extension}`;
    await writeFile(path.join(this.directory, 'uploads', file), bytes, { flag: 'wx' });
    const sortOrder = this.db.prepare('SELECT COALESCE(MIN(sortOrder),0)-1 AS value FROM media WHERE folderId IS ?').get(folderId).value;
    this.db.prepare('INSERT INTO media(id,name,file,mime,size,width,height,hash,createdAt,library,folderId,sortOrder) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, name, file, mime, bytes.length, dimensions.width, dimensions.height, hash, now(), projectId ? 0 : 1, folderId, sortOrder);
    this.registerAsset(id, projectId);
    return this.asset(id);
  }
  registerAsset(id, projectId) {
    if (projectId) this.db.prepare('INSERT OR IGNORE INTO pending_media VALUES(?,?)').run(id, projectId);
    else this.db.prepare('UPDATE media SET library=1 WHERE id=?').run(id);
  }
  promoteAssets(projects) {
    for (const project of projects) for (const id of new Set([coverAssetId(project), ...project.blocks.map(block => block.assetId)].filter(Boolean))) this.db.prepare('UPDATE media SET library=1 WHERE id=?').run(id);
  }
  close() { this.db.close(); }
}

export async function openStore(directory, renderer) {
  for (const sub of ['', 'uploads', 'jobs', 'releases', 'previews']) await mkdir(path.join(directory, sub), { recursive: true });
  const store = new Store(directory);
  if (store.get('imported')) return store;
  const { site, projects } = await loadContent(renderer);
  const assets = new Map();
  async function importAsset(asset) {
    if (assets.has(asset.source)) return assets.get(asset.source);
    const extension = path.extname(asset.source).slice(1).toLowerCase();
    const mime = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' }[extension];
    const saved = await store.addAsset(asset.bytes, path.basename(asset.source), mime, asset, extension);
    assets.set(asset.source, saved.id); return saved.id;
  }
  for (const project of projects) {
    const blocks = [];
    for (let index = 0; index < project.tokens.length; index++) {
      const token = project.tokens[index];
      if (token.type !== 'inline') continue;
      const images = token.children?.filter(child => child.type === 'image') || [];
      for (const image of images) {
        const asset = project.images.find(item => item.token === image);
        blocks.push({ id: randomUUID(), type: 'image', assetId: await importAsset(asset), alt: asset.alt });
      }
      if (!images.length && token.content.trim()) blocks.push({ id: randomUUID(), type: project.tokens[index - 1]?.type === 'heading_open' ? 'heading' : 'text', text: token.content });
    }
    const document = {
      id: project.id, folder: project.folder, title: project.title, category: project.category,
      english: project.english, description: project.description, tags: project.tags, order: project.order,
      coverAssetId: project.coverSource === 'custom' ? await importAsset(project.coverAsset) : null,
      coverRatio: project.coverRatio, blocks,
    };
    store.db.prepare('INSERT OR IGNORE INTO projects(id,draft,live,updatedAt) VALUES(?,?,?,?)').run(project.id, JSON.stringify(document), JSON.stringify(document), now());
  }
  const settings = {
    ...site, brand: site.brand || '噼哩画啦', titleLines: ['创意展开', '有形有色'], tagline: '一些想法，一些作品。', role: '视觉设计师',
    skills: [
      ['品牌', '品牌视觉 · 包装设计'], ['电商', '详情页面 · 营销视觉'], ['UI', '界面设计 · 视觉规范'],
      ['三维', '建模渲染 · 产品表现'], ['动效', '视频剪辑 · 特效合成'], ['AIGC', '图像生成 · 视频创作'],
    ], appearance: { accent: '#4385f5', coverRadius: 0 }, homeBackground: defaultHomeBackground(),
  };
  store.transaction(() => { store.set('settingsDraft', settings); store.set('settingsLive', settings); store.set('settingsRevision', 1); store.set('imported', true); });
  return store;
}
