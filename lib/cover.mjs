export const usesFirstImage = document => document.useFirstImage ?? !document.coverAssetId;
export const coverAssetId = document => usesFirstImage(document) ? document.blocks.find(block => block.type === 'image')?.assetId || null : document.coverAssetId || null;
