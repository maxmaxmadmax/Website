/* SOUNDZGOOD SERVER - inventory-photos
   One-off: shrink and rename inventory photos.
   Helpers shared with other features come from ../shared.js. */
const { onCall } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const crypto = require('crypto');
const { db, requireAdmin } = require('../shared');

/* =========================================================================
   SHRINK + RENAME INVENTORY PHOTOS - one-off from the
   Inventory page. Each photo becomes an 800px WebP named after the product
   (inventory/<product-name>-<id>.webp) and the item's link is updated. The
   old big files are KEPT until Max says to delete them.
   ========================================================================= */
exports.adminOptimisePhotos = onCall({ memory: '1GiB', timeoutSeconds: 540 }, async (request) => {
    requireAdmin(request);
    const sharp = require('sharp');
    const { getStorage } = require('firebase-admin/storage');
    const bucket = getStorage().bucket();
    const snap = await db.collection('inventory').get();
    let done = 0,
        failed = 0,
        before = 0,
        after = 0;
    for (const d of snap.docs) {
        const it = d.data();
        if (!it.photoUrl) continue;
        let oldPath = it.photoPath || '';
        if (!oldPath) {
            const m = /\/o\/([^?]+)/.exec(it.photoUrl);
            oldPath = m ? decodeURIComponent(m[1]) : '';
        }
        if (!oldPath.startsWith('inventory/') || /\.webp$/.test(oldPath)) continue; // done already / not ours
        try {
            const [buf] = await bucket.file(oldPath).download();
            const small = await sharp(buf)
                .rotate()
                .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 82 })
                .toBuffer();
            const slug =
                (String(it.name || 'item')
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-+|-+$/g, '')
                    .slice(0, 60) || 'item') +
                '-' +
                d.id.slice(0, 8);
            const path = 'inventory/' + slug + '.webp';
            const token = crypto.randomUUID();
            await bucket.file(path).save(small, {
                contentType: 'image/webp',
                metadata: { cacheControl: 'public, max-age=31536000', metadata: { firebaseStorageDownloadTokens: token } }
            });
            const url =
                'https://firebasestorage.googleapis.com/v0/b/' +
                bucket.name +
                '/o/' +
                encodeURIComponent(path) +
                '?alt=media&token=' +
                token;
            await d.ref.update({ photoUrl: url, photoPath: path, photoOldPath: oldPath });
            before += buf.length;
            after += small.length;
            done++;
        } catch (err) {
            failed++;
            logger.warn('shrink photo', { id: d.id, err: err && err.message });
        }
    }
    return { ok: true, done, failed, beforeKB: Math.round(before / 1024), afterKB: Math.round(after / 1024) };
});
